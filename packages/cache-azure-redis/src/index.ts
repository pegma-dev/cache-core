import type { CacheStore } from "@pegma/cache-core";
import {
  createRedisCacheStore,
  type RedisCacheStoreOptions,
} from "@pegma/cache-redis";

export type { RedisCacheClient } from "@pegma/cache-redis";

/**
 * Same injected client, clock, and optional key prefix as the generic Redis
 * adapter. Azure Cache for Redis speaks Redis; hosts construct the TLS client
 * at the composition root.
 */
export type AzureRedisCacheStoreOptions = RedisCacheStoreOptions;

/**
 * {@link CacheStore} backed by Azure Cache for Redis.
 *
 * This is a thin composition of {@link createRedisCacheStore}. Expiry stays
 * on the injected Clock, and tag invalidation stays a sidecar index — one
 * key at a time.
 */
export function createAzureRedisCacheStore(
  options: AzureRedisCacheStoreOptions,
): CacheStore {
  return createRedisCacheStore(options);
}
