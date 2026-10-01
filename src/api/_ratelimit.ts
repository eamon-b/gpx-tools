import type { Redis } from "@upstash/redis";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetIn: number;
}

export const RATE_LIMIT = parseInt(process.env.RATE_LIMIT_PER_MINUTE || "10");

/** First hop of `x-forwarded-for` (Vercel sets it), or "unknown". */
export function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
}

/**
 * Fixed one-minute window per key. Throws when Redis does: callers decide
 * whether that fails open.
 */
export async function checkRateLimit(
  redis: Redis,
  key: string,
  limit: number = RATE_LIMIT
): Promise<RateLimitResult> {
  // INCR is atomic and creates the key at 1 if it doesn't exist
  const count = await redis.incr(key);

  // Set expiry only on first request (when count is 1)
  // This is still a race but harmless - worst case we reset the window slightly
  if (count === 1) {
    await redis.expire(key, 60);
  }

  if (count > limit) {
    const ttl = await redis.ttl(key);
    return { allowed: false, remaining: 0, resetIn: ttl > 0 ? ttl : 60 };
  }

  return { allowed: true, remaining: limit - count, resetIn: 60 };
}
