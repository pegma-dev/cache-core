import {
  createSingleFlight,
  formatCacheKey,
  runGetOrCompute,
  type CacheDependencies,
  type CacheGetOrComputeOptions,
  type CacheKey,
  type CacheResult,
  type CacheStore,
  type CacheTtl,
} from "@pegma/cache-core";
import {
  noopLogger,
  type Clock,
  type IsoTimestamp,
  type Logger,
} from "@pegma/spine";

/**
 * Narrow Redis command surface this adapter needs. `ioredis` satisfies it;
 * hosts construct the client at the composition root.
 */
export interface RedisCacheClient {
  getBuffer(key: string): Promise<Buffer | null>;
  set(key: string, value: Buffer): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  sadd(key: string, ...members: string[]): Promise<number>;
  srem(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  ping(): Promise<string>;
}

export interface RedisCacheStoreOptions extends CacheDependencies {
  readonly redis: RedisCacheClient;
  /**
   * Prepended to entry and tag-index keys. Must not contain `{` or `}` so a
   * `CacheKey.hashTag` remains the first hash tag in the wire key.
   * Defaults to `pegma-cache:`.
   */
  readonly keyPrefix?: string;
}

const ENVELOPE_VERSION = 1;
const DEFAULT_PREFIX = "pegma-cache:";

interface RedisEntry {
  bytes: Uint8Array;
  tags: readonly string[];
  absoluteDeadlineMs: number | null;
  slidingMs: number | null;
  expiresAtMs: number | null;
  lastComputeMs: number;
}

function clockMs(clock: Clock): number {
  return Date.parse(clock.now());
}

function toIso(ms: number): IsoTimestamp {
  return new Date(ms).toISOString() as IsoTimestamp;
}

function logOutcome(
  logger: Logger,
  status: "hit" | "miss" | "error" | "compute",
  namespace: string,
): void {
  logger.log("info", `cache.${status}`, { namespace, status });
}

function ttlDeadlines(
  nowMs: number,
  ttl: CacheTtl | undefined,
): Pick<RedisEntry, "absoluteDeadlineMs" | "slidingMs" | "expiresAtMs"> {
  const absoluteMs = ttl?.absoluteMs;
  const slidingMs = ttl?.slidingMs;
  const absoluteDeadlineMs =
    absoluteMs === undefined ? null : nowMs + absoluteMs;
  const sliding = slidingMs === undefined ? null : slidingMs;
  let expiresAtMs: number | null = null;
  if (absoluteDeadlineMs !== null && sliding !== null) {
    expiresAtMs = Math.min(absoluteDeadlineMs, nowMs + sliding);
  } else if (absoluteDeadlineMs !== null) {
    expiresAtMs = absoluteDeadlineMs;
  } else if (sliding !== null) {
    expiresAtMs = nowMs + sliding;
  }
  return { absoluteDeadlineMs, slidingMs: sliding, expiresAtMs };
}

function refreshSliding(entry: RedisEntry, nowMs: number): boolean {
  if (entry.slidingMs === null) {
    return false;
  }
  let next = nowMs + entry.slidingMs;
  if (entry.absoluteDeadlineMs !== null) {
    next = Math.min(next, entry.absoluteDeadlineMs);
  }
  if (entry.expiresAtMs === next) {
    return false;
  }
  entry.expiresAtMs = next;
  return true;
}

function requirePrefix(value: string | undefined): string {
  const prefix = value ?? DEFAULT_PREFIX;
  if (prefix.includes("{") || prefix.includes("}")) {
    throw new Error("keyPrefix must not contain braces");
  }
  return prefix;
}

function encodeEnvelope(entry: RedisEntry): Buffer {
  const meta = new TextEncoder().encode(
    JSON.stringify({
      tags: entry.tags,
      absoluteDeadlineMs: entry.absoluteDeadlineMs,
      slidingMs: entry.slidingMs,
      expiresAtMs: entry.expiresAtMs,
      lastComputeMs: entry.lastComputeMs,
    }),
  );
  const out = Buffer.allocUnsafe(5 + meta.length + entry.bytes.length);
  out[0] = ENVELOPE_VERSION;
  out.writeUInt32BE(meta.length, 1);
  out.set(meta, 5);
  out.set(entry.bytes, 5 + meta.length);
  return out;
}

function asFiniteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function decodeEnvelope(raw: Uint8Array): RedisEntry {
  if (raw.length < 5 || raw[0] !== ENVELOPE_VERSION) {
    throw new Error("invalid cache envelope");
  }
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const metaLen = view.getUint32(1, false);
  if (raw.length < 5 + metaLen) {
    throw new Error("invalid cache envelope");
  }
  const parsed: unknown = JSON.parse(
    new TextDecoder().decode(raw.subarray(5, 5 + metaLen)),
  );
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invalid cache envelope");
  }
  const meta = parsed as Record<string, unknown>;
  const tags = meta["tags"];
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string")) {
    throw new Error("invalid cache envelope");
  }
  const lastComputeMs = meta["lastComputeMs"];
  if (typeof lastComputeMs !== "number" || !Number.isFinite(lastComputeMs)) {
    throw new Error("invalid cache envelope");
  }
  return {
    bytes: raw.subarray(5 + metaLen).slice(),
    tags: [...tags],
    absoluteDeadlineMs: asFiniteOrNull(meta["absoluteDeadlineMs"]),
    slidingMs: asFiniteOrNull(meta["slidingMs"]),
    expiresAtMs: asFiniteOrNull(meta["expiresAtMs"]),
    lastComputeMs,
  };
}

function isExpired(entry: RedisEntry, nowMs: number): boolean {
  return entry.expiresAtMs !== null && nowMs >= entry.expiresAtMs;
}

/**
 * {@link CacheStore} backed by a generic Redis. Expiry is clock-driven.
 * Tag membership lives in a sidecar set per tag so invalidation does not
 * scan and does not issue an implicit multi-key command.
 */
export function createRedisCacheStore(
  options: RedisCacheStoreOptions,
): CacheStore {
  const clock = options.clock;
  const logger = options.logger ?? noopLogger;
  const random = options.random ?? Math.random;
  const redis = options.redis;
  const prefix = requirePrefix(options.keyPrefix);
  const singleFlight = createSingleFlight();

  function entryKey(formatted: string): string {
    return `${prefix}e:${formatted}`;
  }

  function tagKey(tag: string): string {
    return `${prefix}t:${tag}`;
  }

  async function forgetTags(
    formatted: string,
    tags: readonly string[],
  ): Promise<void> {
    for (const tag of tags) {
      await redis.srem(tagKey(tag), formatted);
    }
  }

  async function rememberTags(
    formatted: string,
    tags: readonly string[],
  ): Promise<void> {
    for (const tag of tags) {
      await redis.sadd(tagKey(tag), formatted);
    }
  }

  async function readEntry(formatted: string): Promise<RedisEntry | null> {
    const raw = await redis.getBuffer(entryKey(formatted));
    if (raw === null) {
      return null;
    }
    return decodeEnvelope(raw);
  }

  async function writeEntry(
    formatted: string,
    entry: RedisEntry,
  ): Promise<void> {
    await redis.set(entryKey(formatted), encodeEnvelope(entry));
  }

  async function purge(formatted: string, entry: RedisEntry): Promise<void> {
    await redis.del(entryKey(formatted));
    await forgetTags(formatted, entry.tags);
  }

  const store: CacheStore = {
    async get(key, codec) {
      const formatted = formatCacheKey(key);
      try {
        const raw = await redis.getBuffer(entryKey(formatted));
        if (raw === null) {
          logOutcome(logger, "miss", key.namespace);
          return { status: "miss" };
        }
        let entry: RedisEntry;
        try {
          entry = decodeEnvelope(raw);
        } catch (error) {
          await redis.del(entryKey(formatted));
          logOutcome(logger, "error", key.namespace);
          return { status: "error", error };
        }
        const nowMs = clockMs(clock);
        if (isExpired(entry, nowMs)) {
          await purge(formatted, entry);
          logOutcome(logger, "miss", key.namespace);
          return { status: "miss" };
        }
        if (refreshSliding(entry, nowMs)) {
          await writeEntry(formatted, entry);
        }
        try {
          const value = codec.decode(entry.bytes);
          const hit: CacheResult<typeof value> = {
            status: "hit",
            value,
            ...(entry.expiresAtMs === null
              ? {}
              : { expiresAt: toIso(entry.expiresAtMs) }),
            ...(entry.lastComputeMs > 0
              ? { lastComputeMs: entry.lastComputeMs }
              : {}),
          };
          logOutcome(logger, "hit", key.namespace);
          return hit;
        } catch (error) {
          await purge(formatted, entry);
          logOutcome(logger, "error", key.namespace);
          return { status: "error", error };
        }
      } catch (error) {
        logOutcome(logger, "error", key.namespace);
        return { status: "error", error };
      }
    },

    async set(key, value, codec, setOptions) {
      const formatted = formatCacheKey(key);
      const nowMs = clockMs(clock);
      const bytes = codec.encode(value).slice();
      const tags = [...(setOptions?.tags ?? [])];
      const deadlines = ttlDeadlines(nowMs, setOptions?.ttl);
      try {
        let previous: RedisEntry | null;
        try {
          previous = await readEntry(formatted);
        } catch {
          previous = null;
          await redis.del(entryKey(formatted));
        }
        if (previous !== null) {
          await forgetTags(formatted, previous.tags);
        }
        await writeEntry(formatted, {
          bytes,
          tags,
          lastComputeMs: setOptions?.lastComputeMs ?? 0,
          ...deadlines,
        });
        await rememberTags(formatted, tags);
        return { status: "hit", value: true };
      } catch (error) {
        return { status: "error", error };
      }
    },

    async delete(key) {
      const formatted = formatCacheKey(key);
      try {
        const entry = await readEntry(formatted);
        if (entry === null) {
          return { status: "hit", value: false };
        }
        const expired = isExpired(entry, clockMs(clock));
        await purge(formatted, entry);
        return { status: "hit", value: !expired };
      } catch (error) {
        return { status: "error", error };
      }
    },

    async getOrCompute<T>(
      key: CacheKey,
      computeOptions: CacheGetOrComputeOptions<T>,
    ): Promise<CacheResult<T>> {
      return runGetOrCompute<T>({
        key,
        backend: store,
        clock,
        logger,
        singleFlight,
        random,
        compute: computeOptions.compute,
        codec: computeOptions.codec,
        ...(computeOptions.ttl === undefined
          ? {}
          : { ttl: computeOptions.ttl }),
        ...(computeOptions.tags === undefined
          ? {}
          : { tags: computeOptions.tags }),
        ...(computeOptions.fallback === undefined
          ? {}
          : { fallback: computeOptions.fallback }),
        ...(computeOptions.earlyExpiration === undefined
          ? {}
          : { earlyExpiration: computeOptions.earlyExpiration }),
      });
    },

    async invalidateTags(tags) {
      try {
        let removed = 0;
        for (const tag of tags) {
          const members = await redis.smembers(tagKey(tag));
          for (const formatted of members) {
            let entry: RedisEntry | null;
            try {
              entry = await readEntry(formatted);
            } catch {
              await redis.del(entryKey(formatted));
              entry = null;
            }
            if (entry === null) {
              continue;
            }
            await redis.del(entryKey(formatted));
            await forgetTags(formatted, entry.tags);
            removed += 1;
          }
          await redis.del(tagKey(tag));
        }
        return { status: "hit", value: removed };
      } catch (error) {
        return { status: "error", error };
      }
    },

    async ping() {
      try {
        await redis.ping();
        return { status: "hit", value: true };
      } catch (error) {
        return { status: "error", error };
      }
    },
  };

  return store;
}
