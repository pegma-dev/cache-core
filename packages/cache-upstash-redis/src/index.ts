import type { CacheDependencies, CacheStore } from "@pegma/cache-core";
import {
  createRedisCacheStore,
  type RedisCacheClient,
} from "@pegma/cache-redis";

/**
 * Narrow command surface of `@upstash/redis`. That client is HTTP REST, not
 * the ioredis TCP surface; hosts construct it at the composition root.
 *
 * `eval` takes `(script, keys, args)` — not ioredis `(script, numKeys, ...)`.
 */
export interface UpstashRedisCacheClient {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  sadd(key: string, ...members: string[]): Promise<number>;
  srem(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  ping(): Promise<string>;
  eval(
    script: string,
    keys: string[],
    args: readonly unknown[],
  ): Promise<unknown>;
}

/**
 * Same injected clock, logger, and optional key prefix as the generic Redis
 * adapter. The client is the Upstash REST surface, not `RedisCacheClient`.
 */
export interface UpstashRedisCacheStoreOptions extends CacheDependencies {
  readonly redis: UpstashRedisCacheClient;
  /**
   * Prepended to entry and tag-index keys. Must not contain `{` or `}` so a
   * `CacheKey.hashTag` remains the first hash tag in the wire key.
   * Defaults to `pegma-cache:`.
   */
  readonly keyPrefix?: string;
}

function asWireArg(value: string | Buffer | number): string {
  if (typeof value === "number") {
    return String(value);
  }
  if (typeof value === "string") {
    return value;
  }
  return value.toString("base64");
}

/**
 * REST/JSON cannot carry the binary envelope ioredis `getBuffer` / `set`
 * use. Encode on the wire as base64 so Lua CAS still compares the same
 * bytes the HTTP client stored.
 */
function adaptUpstashRedisClient(
  redis: UpstashRedisCacheClient,
): RedisCacheClient {
  return {
    async getBuffer(key) {
      const raw = await redis.get(key);
      if (raw === null) {
        return null;
      }
      if (typeof raw !== "string") {
        throw new Error("invalid upstash envelope");
      }
      return Buffer.from(raw, "base64");
    },
    set(key, value) {
      return redis.set(key, value.toString("base64"));
    },
    del: (...keys) => redis.del(...keys),
    sadd: (key, ...members) => redis.sadd(key, ...members),
    srem: (key, ...members) => redis.srem(key, ...members),
    smembers: (key) => redis.smembers(key),
    ping: () => redis.ping(),
    eval(script, numKeys, ...args) {
      const keys = args.slice(0, numKeys).map((arg) => String(arg));
      const rest = args.slice(numKeys).map(asWireArg);
      return redis.eval(script, keys, rest);
    },
  };
}

/**
 * {@link CacheStore} backed by Upstash Redis.
 *
 * This wraps the serverless REST client and forwards to
 * {@link createRedisCacheStore} after adapting that client's command shape.
 * Expiry stays on the injected Clock, tag invalidation stays a sidecar
 * index — one key at a time — and a `CacheKey.hashTag` remains the first
 * brace pair on the wire.
 */
export function createUpstashRedisCacheStore(
  options: UpstashRedisCacheStoreOptions,
): CacheStore {
  return createRedisCacheStore({
    clock: options.clock,
    redis: adaptUpstashRedisClient(options.redis),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.random === undefined ? {} : { random: options.random }),
    ...(options.keyPrefix === undefined
      ? {}
      : { keyPrefix: options.keyPrefix }),
  });
}
