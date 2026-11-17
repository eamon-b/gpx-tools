// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import { envPositiveInt } from './_env';

afterEach(() => {
  delete process.env.TEST_LIMIT;
  vi.restoreAllMocks();
});

describe('envPositiveInt', () => {
  it('uses the default when unset or blank', () => {
    expect(envPositiveInt('TEST_LIMIT', 10)).toBe(10);
    process.env.TEST_LIMIT = '  ';
    expect(envPositiveInt('TEST_LIMIT', 10)).toBe(10);
  });

  it('reads a whole number', () => {
    process.env.TEST_LIMIT = ' 25 ';
    expect(envPositiveInt('TEST_LIMIT', 10)).toBe(25);
  });

  it.each(['ten', '0', '-5', '2.5', '10 per minute', 'NaN', 'Infinity'])(
    'falls back (and warns) on %j rather than disabling the limit',
    value => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      process.env.TEST_LIMIT = value;
      expect(envPositiveInt('TEST_LIMIT', 10)).toBe(10);
      expect(warn).toHaveBeenCalledTimes(1);
    }
  );
});
