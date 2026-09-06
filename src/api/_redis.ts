import { Redis, type RedisConfigNodejs } from "@upstash/redis";

// @vercel/kv is deprecated: Vercel's managed KV stores are now Upstash Redis,
// and @vercel/kv@3 is itself just a thin wrapper around @upstash/redis.
//
// Credentials come from whichever integration provisioned the store. The Vercel
// KV/Upstash integration exposes KV_REST_API_* env vars, while a store created
// directly from the Upstash marketplace uses UPSTASH_REDIS_REST_*, so accept
// either to keep existing deployments working without reconfiguration.
//
// @upstash/redis defaults to 5 attempts with exponential backoff, which costs
// roughly 4 s per command when the store is unreachable. The overpass handler
// issues incr + get + set, so the default would burn most of the 30 s Vercel
// budget before Overpass is even called. Redis is best effort here, so fail
// fast instead: one quick retry, then give up and let the caller fall open.
export function createRedisClient(
  options: Partial<RedisConfigNodejs> = {}
): Redis {
  return new Redis({
    url:
      process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "",
    token:
      process.env.KV_REST_API_TOKEN ||
      process.env.UPSTASH_REDIS_REST_TOKEN ||
      "",
    retry: { retries: 1, backoff: () => 100 },
    ...options,
  });
}
