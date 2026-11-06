import { randomBytes } from "node:crypto";

import {
  assertWellFormedCacheString,
  createSingleFlight,
  formatCacheKey,
  runGetOrCompute,
  validateCacheTags,
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
  /**
   * Single-key script runner. Used so a sliding refresh can replace only the
   * envelope it read, without a multi-key command.
   */
  eval(
    script: string,
    numKeys: number,
    ...args: readonly (string | Buffer | number)[]
  ): Promise<unknown>;
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

/** Replace KEYS[1] only when it still equals the envelope this get read. */
const COMPARE_AND_SET = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2])
  return 1
end
return 0
`;

/** Delete KEYS[1] only when it still equals the envelope this operation read. */
const COMPARE_AND_DELETE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

const TAG_MEMBER_SEPARATOR = "\u001F";
const MAX_COMPARE_DELETE_ATTEMPTS = 4;

interface RedisEntry {
  bytes: Uint8Array;
  tags: readonly string[];
  generation: string | null;
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

function slidingRefreshExpiry(entry: RedisEntry, nowMs: number): number | null {
  if (entry.slidingMs === null) {
    return null;
  }
  let next = nowMs + entry.slidingMs;
  if (entry.absoluteDeadlineMs !== null) {
    next = Math.min(next, entry.absoluteDeadlineMs);
  }
  if (entry.expiresAtMs === next) {
    return null;
  }
  return next;
}

function requirePrefix(value: string | undefined): string {
  const prefix = value ?? DEFAULT_PREFIX;
  assertWellFormedCacheString(prefix, "keyPrefix");
  if (prefix.includes("{") || prefix.includes("}")) {
    throw new Error("keyPrefix must not contain braces");
  }
  return prefix;
}

function encodeEnvelope(entry: RedisEntry): Buffer {
  const meta = new TextEncoder().encode(
    JSON.stringify({
      tags: entry.tags,
      generation: entry.generation,
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
  const validatedTags = validateCacheTags(tags as string[]);
  const generation = meta["generation"];
  if (
    generation !== undefined &&
    (typeof generation !== "string" || !/^[0-9a-f]{32}$/u.test(generation))
  ) {
    throw new Error("invalid cache envelope");
  }
  const lastComputeMs = meta["lastComputeMs"];
  if (typeof lastComputeMs !== "number" || !Number.isFinite(lastComputeMs)) {
    throw new Error("invalid cache envelope");
  }
  return {
    bytes: raw.subarray(5 + metaLen).slice(),
    tags: validatedTags,
    generation: generation ?? null,
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

  function tagMember(formatted: string, generation: string): string {
    return `${TAG_MEMBER_SEPARATOR}${generation}${TAG_MEMBER_SEPARATOR}${formatted}`;
  }

  function parseTagMember(
    member: string,
  ):
    | { readonly formatted: string; readonly generation: string | null }
    | undefined {
    if (!member.startsWith(TAG_MEMBER_SEPARATOR)) {
      return { formatted: member, generation: null };
    }
    const separator = member.indexOf(TAG_MEMBER_SEPARATOR, 1);
    if (separator === -1) {
      return undefined;
    }
    const generation = member.slice(1, separator);
    const formatted = member.slice(separator + 1);
    if (!/^[0-9a-f]{32}$/u.test(generation) || formatted.length === 0) {
      return undefined;
    }
    return { formatted, generation };
  }

  async function forgetTags(
    formatted: string,
    entry: Pick<RedisEntry, "generation" | "tags">,
  ): Promise<void> {
    const member =
      entry.generation === null
        ? formatted
        : tagMember(formatted, entry.generation);
    for (const tag of entry.tags) {
      await redis.srem(tagKey(tag), member);
    }
  }

  async function rememberTags(
    formatted: string,
    entry: Pick<RedisEntry, "generation" | "tags">,
  ): Promise<void> {
    if (entry.generation === null) {
      throw new Error("new cache entries require a generation");
    }
    const member = tagMember(formatted, entry.generation);
    for (const tag of entry.tags) {
      await redis.sadd(tagKey(tag), member);
    }
  }

  async function readEntry(
    formatted: string,
  ): Promise<{ readonly entry: RedisEntry; readonly raw: Buffer } | null> {
    const raw = await redis.getBuffer(entryKey(formatted));
    if (raw === null) {
      return null;
    }
    return { entry: decodeEnvelope(raw), raw };
  }

  async function compareAndSetEntry(
    formatted: string,
    expected: Buffer,
    next: RedisEntry,
  ): Promise<Buffer | null> {
    const nextRaw = encodeEnvelope(next);
    const replaced = await redis.eval(
      COMPARE_AND_SET,
      1,
      entryKey(formatted),
      expected,
      nextRaw,
    );
    return replaced === 1 ? nextRaw : null;
  }

  async function compareAndDeleteEntry(
    formatted: string,
    expected: Buffer,
  ): Promise<boolean> {
    const deleted = await redis.eval(
      COMPARE_AND_DELETE,
      1,
      entryKey(formatted),
      expected,
    );
    return deleted === 1;
  }

  async function purge(
    formatted: string,
    raw: Buffer,
    entry: RedisEntry,
  ): Promise<boolean> {
    let observedRaw = raw;
    let observedEntry = entry;
    for (let attempt = 0; attempt < MAX_COMPARE_DELETE_ATTEMPTS; attempt += 1) {
      if (await compareAndDeleteEntry(formatted, observedRaw)) {
        await forgetTags(formatted, observedEntry);
        return true;
      }
      if (entry.generation === null) {
        return false;
      }
      let current: { readonly entry: RedisEntry; readonly raw: Buffer } | null;
      try {
        current = await readEntry(formatted);
      } catch {
        return false;
      }
      if (current === null || current.entry.generation !== entry.generation) {
        return false;
      }
      observedRaw = current.raw;
      observedEntry = current.entry;
    }
    return false;
  }

  const store: CacheStore = {
    async get(key, codec) {
      const formatted = formatCacheKey(key);
      try {
        const fetched = await redis.getBuffer(entryKey(formatted));
        if (fetched === null) {
          logOutcome(logger, "miss", key.namespace);
          return { status: "miss" };
        }
        let raw = fetched;
        let entry: RedisEntry;
        try {
          entry = decodeEnvelope(raw);
        } catch (error) {
          await compareAndDeleteEntry(formatted, raw);
          logOutcome(logger, "error", key.namespace);
          return { status: "error", error };
        }
        const nowMs = clockMs(clock);
        if (isExpired(entry, nowMs)) {
          await purge(formatted, raw, entry);
          logOutcome(logger, "miss", key.namespace);
          return { status: "miss" };
        }
        const refreshedExpiresAtMs = slidingRefreshExpiry(entry, nowMs);
        if (refreshedExpiresAtMs !== null) {
          const refreshed = { ...entry, expiresAtMs: refreshedExpiresAtMs };
          const refreshedRaw = await compareAndSetEntry(
            formatted,
            raw,
            refreshed,
          );
          if (refreshedRaw !== null) {
            entry = refreshed;
            raw = refreshedRaw;
          }
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
          await purge(formatted, raw, entry);
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
      const tags = validateCacheTags(setOptions?.tags ?? []);
      const bytes = codec.encode(value).slice();
      const deadlines = ttlDeadlines(nowMs, setOptions?.ttl);
      try {
        let previous: {
          readonly entry: RedisEntry;
          readonly raw: Buffer;
        } | null;
        try {
          previous = await readEntry(formatted);
        } catch {
          previous = null;
        }
        const next: RedisEntry = {
          bytes,
          tags,
          generation: randomBytes(16).toString("hex"),
          lastComputeMs: setOptions?.lastComputeMs ?? 0,
          ...deadlines,
        };
        await redis.set(entryKey(formatted), encodeEnvelope(next));
        await rememberTags(formatted, next);
        if (previous !== null) {
          await forgetTags(formatted, previous.entry);
        }
        return { status: "hit", value: true };
      } catch (error) {
        return { status: "error", error };
      }
    },

    async delete(key) {
      const formatted = formatCacheKey(key);
      try {
        const current = await readEntry(formatted);
        if (current === null) {
          return { status: "hit", value: false };
        }
        const expired = isExpired(current.entry, clockMs(clock));
        const deleted = await purge(formatted, current.raw, current.entry);
        return { status: "hit", value: deleted && !expired };
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
      const validatedTags = validateCacheTags(tags);
      try {
        let removed = 0;
        for (const tag of validatedTags) {
          const members = await redis.smembers(tagKey(tag));
          for (const member of members) {
            const parsed = parseTagMember(member);
            if (parsed === undefined) {
              await redis.srem(tagKey(tag), member);
              continue;
            }
            const raw = await redis.getBuffer(entryKey(parsed.formatted));
            if (raw === null) {
              await redis.srem(tagKey(tag), member);
              continue;
            }
            let entry: RedisEntry;
            try {
              entry = decodeEnvelope(raw);
            } catch {
              if (await compareAndDeleteEntry(parsed.formatted, raw)) {
                await redis.srem(tagKey(tag), member);
              }
              continue;
            }
            if (
              entry.generation !== parsed.generation ||
              !entry.tags.includes(tag)
            ) {
              await redis.srem(tagKey(tag), member);
              continue;
            }
            if (await purge(parsed.formatted, raw, entry)) {
              removed += 1;
            }
          }
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
