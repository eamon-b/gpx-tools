/**
 * Read a positive integer setting from the environment.
 *
 * `parseInt(process.env.X || '10')` turns a typo (`RATE_LIMIT_PER_MINUTE=ten`)
 * into NaN, and every comparison against NaN is false - a rate limit of NaN
 * is no rate limit at all, and a cache TTL of NaN is rejected by Redis on
 * every write. Anything that is not a whole number above zero falls back to
 * the default, with a warning so the misconfiguration is visible in the logs.
 */
export function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value <= 0) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        context: 'env',
        message: `${name} must be a positive integer; using the default`,
        value: raw,
        fallback,
      })
    );
    return fallback;
  }
  return value;
}
