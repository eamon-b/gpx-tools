// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { redisMock } = vi.hoisted(() => ({
  redisMock: {
    incr: vi.fn(),
    expire: vi.fn(),
    ttl: vi.fn(),
    get: vi.fn(),
    mget: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    pipeline: vi.fn(),
    exec: vi.fn(),
  },
}));

vi.mock('./_redis', () => ({
  createRedisClient: () => redisMock,
}));

import handler from './elevation';

function post(body: unknown): Request {
  return new Request('https://example.test/api/elevation', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
    body: JSON.stringify(body),
  });
}

function upstream(results: { latitude: number; longitude: number; elevation: number }[]) {
  const fn = vi.fn(async () => new Response(JSON.stringify({ results }), { status: 200 }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => {
  for (const fn of Object.values(redisMock)) fn.mockReset();
  redisMock.incr.mockResolvedValue(1);
  redisMock.get.mockResolvedValue(null);
  redisMock.mget.mockImplementation(async (...keys: string[]) => keys.map(() => null));
  // The pipeline records its SETs on the same mock the assertions read.
  redisMock.pipeline.mockImplementation(() => ({ set: redisMock.set, exec: redisMock.exec }));
  redisMock.exec.mockResolvedValue([]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('elevation handler', () => {
  it('rate limits per IP with a 429 and Retry-After', async () => {
    redisMock.incr.mockResolvedValue(31);
    redisMock.ttl.mockResolvedValue(42);
    const fn = upstream([]);

    const res = await handler(post({ locations: [{ lat: 1, lon: 2 }] }));

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('42');
    expect(redisMock.incr).toHaveBeenCalledWith('ratelimit:elevation:203.0.113.7');
    expect(fn).not.toHaveBeenCalled();
  });

  it('fails open when the rate limiter cannot reach Redis', async () => {
    redisMock.incr.mockRejectedValue(new Error('redis down'));
    upstream([{ latitude: 1, longitude: 2, elevation: 100 }]);

    const res = await handler(post({ locations: [{ lat: 1, lon: 2 }] }));

    expect(res.status).toBe(200);
    expect((await res.json()).results).toEqual([{ lat: 1, lon: 2, elevation: 100 }]);
  });

  it('matches upstream results by coordinate, not position', async () => {
    // Reordered and short: the middle point got no answer.
    upstream([
      { latitude: 3, longitude: 3, elevation: 300 },
      { latitude: 1, longitude: 1, elevation: 100 },
    ]);

    const res = await handler(
      post({ locations: [{ lat: 1, lon: 1 }, { lat: 2, lon: 2 }, { lat: 3, lon: 3 }] })
    );
    const { results } = await res.json();

    expect(results).toEqual([
      { lat: 1, lon: 1, elevation: 100 },
      { lat: 2, lon: 2, elevation: null },
      { lat: 3, lon: 3, elevation: 300 },
    ]);
    // Only the two real answers are cached, each under its own key.
    expect(redisMock.set).toHaveBeenCalledTimes(2);
    expect(redisMock.set).toHaveBeenCalledWith('elev:1:1', 100, expect.anything());
    expect(redisMock.set).toHaveBeenCalledWith('elev:3:3', 300, expect.anything());
    // ...and written in one pipelined round trip, not one request per point.
    expect(redisMock.exec).toHaveBeenCalledTimes(1);
  });

  it('reads the cache in one MGET and only fetches what is missing', async () => {
    redisMock.mget.mockResolvedValue([111, null]);
    const fn = upstream([{ latitude: 2, longitude: 2, elevation: 222 }]);

    const res = await handler(post({ locations: [{ lat: 1, lon: 1 }, { lat: 2, lon: 2 }] }));
    const body = await res.json();

    expect(redisMock.mget).toHaveBeenCalledTimes(1);
    expect(redisMock.mget).toHaveBeenCalledWith('elev:1:1', 'elev:2:2');
    expect(body.results).toEqual([
      { lat: 1, lon: 1, elevation: 111 },
      { lat: 2, lon: 2, elevation: 222 },
    ]);
    expect(body.cached).toBe(1);
    const [, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).locations).toEqual([{ lat: 2, lon: 2 }]);
  });

  it('still answers when every Redis call fails', async () => {
    for (const fn of Object.values(redisMock)) fn.mockRejectedValue(new Error('redis down'));
    redisMock.pipeline.mockImplementation(() => ({ set: redisMock.set, exec: redisMock.exec }));
    upstream([{ latitude: 1, longitude: 2, elevation: 100 }]);

    const res = await handler(post({ locations: [{ lat: 1, lon: 2 }] }));

    expect(res.status).toBe(200);
    expect((await res.json()).results).toEqual([{ lat: 1, lon: 2, elevation: 100 }]);
  });

  it('serves a fully cached request without touching the rate limit or the circuit', async () => {
    redisMock.mget.mockResolvedValue([111]);
    redisMock.incr.mockResolvedValue(999); // would be over the limit
    redisMock.get.mockResolvedValue({ failures: 9, lastFailure: Math.floor(Date.now() / 1000), isOpen: true });
    const fn = upstream([]);

    const res = await handler(post({ locations: [{ lat: 1, lon: 1 }] }));

    expect(res.status).toBe(200);
    expect((await res.json()).results).toEqual([{ lat: 1, lon: 1, elevation: 111 }]);
    expect(redisMock.incr).not.toHaveBeenCalled();
    expect(fn).not.toHaveBeenCalled();
  });

  describe('circuit breaker', () => {
    const now = () => Math.floor(Date.now() / 1000);
    const failing = () => {
      const fn = vi.fn(async () => new Response('nope', { status: 500 }));
      vi.stubGlobal('fetch', fn);
      return fn;
    };

    it('refuses with a 503 while open', async () => {
      redisMock.get.mockResolvedValue({ failures: 5, lastFailure: now() - 10, isOpen: true });
      const fn = upstream([]);

      const res = await handler(post({ locations: [{ lat: 1, lon: 2 }] }));

      expect(res.status).toBe(503);
      expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
      expect(fn).not.toHaveBeenCalled();
    });

    it('lets one probe through after the timeout and claims it', async () => {
      redisMock.get.mockResolvedValue({ failures: 5, lastFailure: now() - 61, isOpen: true });
      const fn = upstream([{ latitude: 1, longitude: 2, elevation: 100 }]);

      const res = await handler(post({ locations: [{ lat: 1, lon: 2 }] }));

      expect(res.status).toBe(200);
      expect(fn).toHaveBeenCalledTimes(1);
      // Claimed: the stored state is pushed forward so other requests stay refused...
      const claim = redisMock.set.mock.calls.find(([key]) => key === 'circuit:elevation');
      expect(claim?.[1]).toMatchObject({ isOpen: true });
      expect(claim?.[1].lastFailure).toBeGreaterThanOrEqual(now() - 1);
      // ...and the successful probe closes the circuit.
      expect(redisMock.del).toHaveBeenCalledWith('circuit:elevation');
    });

    it('re-opens when the probe fails', async () => {
      redisMock.get.mockResolvedValue({ failures: 5, lastFailure: now() - 61, isOpen: true });
      failing();

      const res = await handler(post({ locations: [{ lat: 1, lon: 2 }] }));

      expect(res.status).toBe(200);
      expect((await res.json()).results).toEqual([{ lat: 1, lon: 2, elevation: null }]);
      const writes = redisMock.set.mock.calls.filter(([key]) => key === 'circuit:elevation');
      const last = writes[writes.length - 1][1];
      expect(last.isOpen).toBe(true);
      expect(last.failures).toBe(6);
      expect(last.lastFailure).toBeGreaterThanOrEqual(now() - 1);
      expect(redisMock.del).not.toHaveBeenCalled();
    });

    it('stops calling upstream for the rest of a request once it opens', async () => {
      redisMock.get.mockResolvedValue({ failures: 4, lastFailure: now() - 5, isOpen: false });
      const fn = failing();
      const locations = Array.from({ length: 250 }, (_, i) => ({ lat: i / 100, lon: 0 }));

      const res = await handler(post({ locations }));
      const { results } = await res.json();

      expect(fn).toHaveBeenCalledTimes(1); // not once per 100-point batch
      expect(results).toHaveLength(250);
      expect(results.every((r: { elevation: number | null }) => r.elevation === null)).toBe(true);
    });
  });

  it('rejects a malformed location with a 400, not a 500', async () => {
    const res = await handler(post({ locations: [null] }));
    expect(res.status).toBe(400);
  });
});
