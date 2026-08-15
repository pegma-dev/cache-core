import {
  noopLogger,
  type Clock,
  type IsoTimestamp,
  type Logger,
} from "@pegma/spine";

/** Outcome of a cache operation. */
export type CacheResult<T> =
  | {
      readonly status: "hit";
      readonly value: T;
      readonly expiresAt?: IsoTimestamp;
      readonly lastComputeMs?: number;
    }
  | { readonly status: "miss" }
  | { readonly status: "error"; readonly error: unknown };

/** Schema-aware encode/decode over opaque bytes. */
export interface CacheCodec<T> {
  readonly encode: (value: T) => Uint8Array;
  readonly decode: (bytes: Uint8Array) => T;
}

/**
 * Logical cache address. {@link formatCacheKey} is the only legal wire form.
 * `hashTag`, when present, becomes `{tag}` so a Redis Cluster adapter can
 * colocate keys; the port never implies a multi-key operation.
 */
export interface CacheKey {
  readonly namespace: string;
  readonly key: string;
  readonly hashTag?: string;
}

export type CacheFallbackPolicy = "fail-open" | "fail-closed";

export interface CacheTtl {
  readonly absoluteMs?: number;
  readonly slidingMs?: number;
}

export interface CacheSetOptions {
  readonly ttl?: CacheTtl;
  readonly tags?: readonly string[];
  readonly lastComputeMs?: number;
}

export interface CacheEarlyExpiration {
  readonly beta?: number;
}

export interface CacheGetOrComputeOptions<T> {
  readonly compute: () => Promise<T> | T;
  readonly codec: CacheCodec<T>;
  readonly ttl?: CacheTtl;
  readonly tags?: readonly string[];
  readonly fallback?: CacheFallbackPolicy;
  readonly earlyExpiration?: CacheEarlyExpiration;
}

export interface CacheStore {
  get<T>(key: CacheKey, codec: CacheCodec<T>): Promise<CacheResult<T>>;
  set<T>(
    key: CacheKey,
    value: T,
    codec: CacheCodec<T>,
    options?: CacheSetOptions,
  ): Promise<CacheResult<true>>;
  delete(key: CacheKey): Promise<CacheResult<boolean>>;
  getOrCompute<T>(
    key: CacheKey,
    options: CacheGetOrComputeOptions<T>,
  ): Promise<CacheResult<T>>;
  invalidateTags(tags: readonly string[]): Promise<CacheResult<number>>;
  ping(): Promise<CacheResult<true>>;
}

export interface CacheDependencies {
  readonly clock: Clock;
  readonly logger?: Logger;
  readonly random?: () => number;
}

/** Rejects a {@link CacheKey} that cannot be formatted safely. */
export class CacheKeyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CacheKeyValidationError";
  }
}

const CONTROL = /[\u0000-\u001F\u007F]/u;

function requireToken(value: string, label: string): string {
  if (value.length === 0) {
    throw new CacheKeyValidationError(`${label} must not be empty`);
  }
  if (CONTROL.test(value)) {
    throw new CacheKeyValidationError(`${label} must not contain controls`);
  }
  if (value.includes("{") || value.includes("}")) {
    throw new CacheKeyValidationError(`${label} must not contain braces`);
  }
  return value;
}

/**
 * Formats a {@link CacheKey} for the wire. Namespaces cannot contain `:`, so
 * `namespace:key` cannot collide across a `:` inside the key.
 */
export function formatCacheKey(key: CacheKey): string {
  const namespace = requireToken(key.namespace, "namespace");
  if (namespace.includes(":")) {
    throw new CacheKeyValidationError("namespace must not contain ':'");
  }
  const id = requireToken(key.key, "key");
  if (key.hashTag === undefined) {
    return `${namespace}:${id}`;
  }
  const hashTag = requireToken(key.hashTag, "hashTag");
  return `{${hashTag}}${namespace}:${id}`;
}

export function jsonCodec<T>(): CacheCodec<T> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  return {
    encode(value) {
      return encoder.encode(JSON.stringify(value));
    },
    decode(bytes) {
      return JSON.parse(decoder.decode(bytes)) as T;
    },
  };
}

export const bytesCodec: CacheCodec<Uint8Array> = {
  encode(value) {
    return value.slice();
  },
  decode(bytes) {
    return bytes.slice();
  },
};

export interface SingleFlight {
  do<T>(key: string, work: () => Promise<T>): Promise<T>;
}

/** Process-local coalescing. Not a distributed lock. */
export function createSingleFlight(): SingleFlight {
  const inflight = new Map<string, Promise<unknown>>();
  return {
    do<T>(key: string, work: () => Promise<T>): Promise<T> {
      const existing = inflight.get(key);
      if (existing !== undefined) {
        return existing as Promise<T>;
      }
      const pending = Promise.resolve()
        .then(work)
        .finally(() => {
          inflight.delete(key);
        });
      inflight.set(key, pending);
      return pending;
    },
  };
}

export interface ControllableClock extends Clock {
  set(at: IsoTimestamp): void;
  advance(ms: number): void;
}

export function createControllableClock(
  start: IsoTimestamp,
): ControllableClock {
  let current = start;
  return {
    now: () => current,
    set(at) {
      current = at;
    },
    advance(ms) {
      current = new Date(
        Date.parse(current) + ms,
      ).toISOString() as IsoTimestamp;
    },
  };
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

/**
 * Classic XFetch: recompute when
 * `now - expiry >= beta * lastComputeMs * log(random())`.
 */
export function shouldExpireEarly(options: {
  readonly nowMs: number;
  readonly expiresAtMs: number;
  readonly lastComputeMs: number;
  readonly beta: number;
  readonly random: () => number;
}): boolean {
  if (options.lastComputeMs <= 0 || options.beta <= 0) {
    return false;
  }
  const unit = options.random();
  const sample = unit > 0 && unit < 1 ? unit : Number.EPSILON;
  return (
    options.nowMs - options.expiresAtMs >=
    options.beta * options.lastComputeMs * Math.log(sample)
  );
}

export interface GetOrComputeBackend<T> {
  get(key: CacheKey, codec: CacheCodec<T>): Promise<CacheResult<T>>;
  set(
    key: CacheKey,
    value: T,
    codec: CacheCodec<T>,
    options?: CacheSetOptions,
  ): Promise<CacheResult<true>>;
}

export interface RunGetOrComputeOptions<T> extends CacheGetOrComputeOptions<T> {
  readonly key: CacheKey;
  readonly backend: GetOrComputeBackend<T>;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly singleFlight: SingleFlight;
  readonly random?: () => number;
}

/**
 * Cache-aside helper adapters should call. Single-flight is process-local.
 * Fail-open computes when `get` errors; fail-closed returns that error.
 */
export async function runGetOrCompute<T>(
  options: RunGetOrComputeOptions<T>,
): Promise<CacheResult<T>> {
  const formatted = formatCacheKey(options.key);
  const fallback = options.fallback ?? "fail-closed";
  const random = options.random ?? Math.random;
  return options.singleFlight.do(formatted, async () => {
    let read: CacheResult<T>;
    try {
      read = await options.backend.get(options.key, options.codec);
    } catch (error) {
      read = { status: "error", error };
    }

    if (read.status === "hit") {
      const expiresAt = read.expiresAt;
      const lastComputeMs = read.lastComputeMs;
      if (
        options.earlyExpiration !== undefined &&
        expiresAt !== undefined &&
        lastComputeMs !== undefined
      ) {
        const beta = options.earlyExpiration.beta ?? 1;
        if (
          shouldExpireEarly({
            nowMs: clockMs(options.clock),
            expiresAtMs: Date.parse(expiresAt),
            lastComputeMs,
            beta,
            random,
          })
        ) {
          const recomputed = await computeAndStore(
            options,
            clockMs(options.clock),
          );
          if (recomputed.status === "hit") {
            return recomputed;
          }
          return read;
        }
      }
      logOutcome(options.logger, "hit", options.key.namespace);
      return read;
    }

    if (read.status === "error") {
      logOutcome(options.logger, "error", options.key.namespace);
      if (fallback === "fail-closed") {
        return read;
      }
    } else {
      logOutcome(options.logger, "miss", options.key.namespace);
    }

    return computeAndStore(options, clockMs(options.clock));
  });
}

async function computeAndStore<T>(
  options: RunGetOrComputeOptions<T>,
  startedMs: number,
): Promise<CacheResult<T>> {
  logOutcome(options.logger, "compute", options.key.namespace);
  try {
    const value = await options.compute();
    const lastComputeMs = Math.max(0, clockMs(options.clock) - startedMs);
    const setOptions: CacheSetOptions = {
      ...(options.ttl === undefined ? {} : { ttl: options.ttl }),
      ...(options.tags === undefined ? {} : { tags: options.tags }),
      lastComputeMs,
    };
    try {
      await options.backend.set(options.key, value, options.codec, setOptions);
    } catch {
      // A failed write must not hide a successful compute.
    }
    return { status: "hit", value };
  } catch (error) {
    return { status: "error", error };
  }
}

interface MemoryEntry {
  bytes: Uint8Array;
  tags: readonly string[];
  absoluteDeadlineMs: number | null;
  slidingMs: number | null;
  expiresAtMs: number | null;
  lastComputeMs: number;
}

function ttlDeadlines(
  nowMs: number,
  ttl: CacheTtl | undefined,
): Pick<MemoryEntry, "absoluteDeadlineMs" | "slidingMs" | "expiresAtMs"> {
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

function refreshSliding(entry: MemoryEntry, nowMs: number): void {
  if (entry.slidingMs === null) {
    return;
  }
  let next = nowMs + entry.slidingMs;
  if (entry.absoluteDeadlineMs !== null) {
    next = Math.min(next, entry.absoluteDeadlineMs);
  }
  entry.expiresAtMs = next;
}

export function createMemoryCacheStore(options: CacheDependencies): CacheStore {
  const clock = options.clock;
  const logger = options.logger ?? noopLogger;
  const random = options.random ?? Math.random;
  const entries = new Map<string, MemoryEntry>();
  const tagged = new Map<string, Set<string>>();
  const singleFlight = createSingleFlight();

  function forgetTags(formatted: string, tags: readonly string[]): void {
    for (const tag of tags) {
      const keys = tagged.get(tag);
      if (keys === undefined) {
        continue;
      }
      keys.delete(formatted);
      if (keys.size === 0) {
        tagged.delete(tag);
      }
    }
  }

  function rememberTags(formatted: string, tags: readonly string[]): void {
    for (const tag of tags) {
      const keys = tagged.get(tag) ?? new Set<string>();
      keys.add(formatted);
      tagged.set(tag, keys);
    }
  }

  const store: CacheStore = {
    async get(key, codec) {
      const formatted = formatCacheKey(key);
      const entry = entries.get(formatted);
      const nowMs = clockMs(clock);
      if (
        entry === undefined ||
        (entry.expiresAtMs !== null && nowMs >= entry.expiresAtMs)
      ) {
        if (entry !== undefined) {
          forgetTags(formatted, entry.tags);
          entries.delete(formatted);
        }
        logOutcome(logger, "miss", key.namespace);
        return { status: "miss" };
      }
      refreshSliding(entry, nowMs);
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
        forgetTags(formatted, entry.tags);
        entries.delete(formatted);
        logOutcome(logger, "error", key.namespace);
        return { status: "error", error };
      }
    },

    async set(key, value, codec, setOptions) {
      const formatted = formatCacheKey(key);
      const nowMs = clockMs(clock);
      const previous = entries.get(formatted);
      if (previous !== undefined) {
        forgetTags(formatted, previous.tags);
      }
      const tags = setOptions?.tags ?? [];
      const deadlines = ttlDeadlines(nowMs, setOptions?.ttl);
      entries.set(formatted, {
        bytes: codec.encode(value).slice(),
        tags,
        lastComputeMs: setOptions?.lastComputeMs ?? 0,
        ...deadlines,
      });
      rememberTags(formatted, tags);
      return { status: "hit", value: true };
    },

    async delete(key) {
      const formatted = formatCacheKey(key);
      const entry = entries.get(formatted);
      if (entry === undefined) {
        return { status: "hit", value: false };
      }
      forgetTags(formatted, entry.tags);
      entries.delete(formatted);
      return { status: "hit", value: true };
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
      let removed = 0;
      for (const tag of tags) {
        const keys = tagged.get(tag);
        if (keys === undefined) {
          continue;
        }
        for (const formatted of [...keys]) {
          const entry = entries.get(formatted);
          if (entry === undefined) {
            continue;
          }
          forgetTags(formatted, entry.tags);
          entries.delete(formatted);
          removed += 1;
        }
      }
      return { status: "hit", value: removed };
    },

    async ping() {
      return { status: "hit", value: true };
    },
  };

  return store;
}

/**
 * Backend that always errors on storage ops. `getOrCompute` still computes
 * under fail-open. This is a test double, not a local-memory fallback.
 */
export function createUnavailableCacheStore(
  options: CacheDependencies,
): CacheStore {
  const clock = options.clock;
  const logger = options.logger ?? noopLogger;
  const random = options.random ?? Math.random;
  const singleFlight = createSingleFlight();
  const down = new Error("cache backend unavailable");

  const store: CacheStore = {
    async get() {
      return { status: "error", error: down };
    },
    async set() {
      return { status: "error", error: down };
    },
    async delete() {
      return { status: "error", error: down };
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
    async invalidateTags() {
      return { status: "error", error: down };
    },
    async ping() {
      return { status: "error", error: down };
    },
  };

  return store;
}
