import type { CacheStore } from "@pegma/cache-core";
import {
  createRedisCacheStore,
  type RedisCacheStoreOptions,
} from "@pegma/cache-redis";

export type { RedisCacheClient } from "@pegma/cache-redis";

/**
 * Same injected client, clock, and optional key prefix as the generic Redis
 * adapter. ElastiCache speaks Redis; hosts construct the TLS client at the
 * composition root.
 */
export type ElastiCacheCacheStoreOptions = RedisCacheStoreOptions;

/**
 * {@link CacheStore} backed by Amazon ElastiCache.
 *
 * This is a thin composition of {@link createRedisCacheStore}. Expiry stays
 * on the injected Clock, tag invalidation stays a sidecar index — one key
 * at a time — and a `CacheKey.hashTag` remains the first brace pair on the
 * wire so Redis Cluster slots colocate.
 */
export function createElastiCacheCacheStore(
  options: ElastiCacheCacheStoreOptions,
): CacheStore {
  return createRedisCacheStore(options);
}
