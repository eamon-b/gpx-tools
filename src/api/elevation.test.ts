// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { redisMock } = vi.hoisted(() => ({
  redisMock: {
    incr: vi.fn(),
    expire: vi.fn(),
    ttl: vi.fn(),
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
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
  });
});
