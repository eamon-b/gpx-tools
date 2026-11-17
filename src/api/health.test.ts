// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { redisMock } = vi.hoisted(() => ({
  redisMock: {
    incr: vi.fn(),
    expire: vi.fn(),
    ttl: vi.fn(),
    get: vi.fn(),
    set: vi.fn(),
  },
}));

vi.mock('./_redis', () => ({
  createRedisClient: () => redisMock,
}));

import handler, { resetHealthCache } from './health';

function get(method = 'GET'): Request {
  return new Request('https://example.test/api/health', {
    method,
    headers: { 'x-forwarded-for': '203.0.113.7' },
  });
}

function upstreams(status = 200) {
  const fn = vi.fn(async () => new Response('ok', { status }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => {
  resetHealthCache();
  for (const fn of Object.values(redisMock)) fn.mockReset();
  redisMock.incr.mockResolvedValue(1);
  redisMock.get.mockImplementation(async () => `health-${Date.now()}`);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('health handler', () => {
  it('reports healthy when every check passes', async () => {
    const fn = upstreams();

    const res = await handler(get());

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: 'healthy',
      checks: { kv: true, overpass: true, elevation: true },
    });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('reuses a recent result instead of probing on every request', async () => {
    const fn = upstreams();

    await handler(get());
    for (let i = 0; i < 20; i++) {
      expect((await handler(get())).status).toBe(200);
    }

    expect(fn).toHaveBeenCalledTimes(2); // one probe: overpass + elevation
    expect(redisMock.set).toHaveBeenCalledTimes(1);
    expect(redisMock.incr).toHaveBeenCalledTimes(1);
  });

  it('probes again once the result has aged out', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const fn = upstreams();

    await handler(get());
    vi.setSystemTime(Date.now() + 31_000);
    await handler(get());

    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('shares one probe between concurrent requests', async () => {
    const fn = upstreams();

    const responses = await Promise.all([handler(get()), handler(get()), handler(get())]);

    expect(responses.map(r => r.status)).toEqual([200, 200, 200]);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('rate limits fresh probes per IP', async () => {
    const fn = upstreams();
    redisMock.incr.mockResolvedValue(7);
    redisMock.ttl.mockResolvedValue(40);

    const res = await handler(get());

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('40');
    expect(redisMock.incr).toHaveBeenCalledWith('ratelimit:health:203.0.113.7');
    expect(fn).not.toHaveBeenCalled();
  });

  it('reports unhealthy, without leaking the error text, when Redis is down', async () => {
    upstreams();
    const boom = new Error('fetch failed: https://secret-host.upstash.io');
    redisMock.incr.mockRejectedValue(boom);
    redisMock.set.mockRejectedValue(boom);

    const res = await handler(get());
    const text = await res.text();

    expect(res.status).toBe(503);
    expect(JSON.parse(text)).toMatchObject({ status: 'unhealthy', checks: { kv: false } });
    expect(text).not.toContain('secret-host');
  });

  it('reports degraded when only an upstream is down', async () => {
    upstreams(503);

    const res = await handler(get());

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: 'degraded',
      checks: { kv: true, overpass: false, elevation: false },
      details: { overpass: 'HTTP 503' },
    });
  });

  it('answers HEAD without a body and rejects other methods', async () => {
    upstreams();

    const head = await handler(get('HEAD'));
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');

    const post = await handler(get('POST'));
    expect(post.status).toBe(405);
    expect(redisMock.set).toHaveBeenCalledTimes(1); // the POST probed nothing
  });
});
