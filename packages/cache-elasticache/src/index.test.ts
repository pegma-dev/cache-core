import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createControllableClock,
  formatCacheKey,
  jsonCodec,
} from "@pegma/cache-core";
import { conformanceCases } from "@pegma/cache-conformance";
import {
  createRedisCacheStore,
  type RedisCacheClient,
} from "@pegma/cache-redis";
import { noopLogger } from "@pegma/spine";

import { REDIS_URL } from "../../../tests/redis-server.js";
import { createElastiCacheCacheStore } from "./index.js";

const START = "2026-08-15T16:00:00.000Z";

const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 1,
});

beforeAll(async () => {
  await redis.ping();
});

afterAll(async () => {
  await redis.quit();
});

let prefixCounter = 0;

function nextPrefix(): string {
  prefixCounter += 1;
  return `pegma-cache:ec${String(process.pid)}:${String(prefixCounter)}:`;
}

function unavailableRedis(): RedisCacheClient {
  const down = new Error("cache backend unavailable");
  const reject = async (): Promise<never> => {
    throw down;
  };
  return {
    getBuffer: reject,
    set: reject,
    del: reject,
    sadd: reject,
    srem: reject,
    smembers: reject,
    ping: reject,
    eval: reject,
  };
}

/**
 * Redis Cluster CRC-16 (XMODEM, poly 0x1021) as used by `CLUSTER KEYSLOT`.
 * Lives in the test so production code does not grow a multi-key helper.
 */
function redisCrc16(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) !== 0 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc;
}

/**
 * Slot of a Redis Cluster wire key. The first non-empty `{tag}` is hashed;
 * otherwise the whole key is. Matches `keyHashSlot` in Redis.
 */
function redisClusterSlot(wireKey: string): number {
  const start = wireKey.indexOf("{");
  if (start !== -1) {
    const end = wireKey.indexOf("}", start + 1);
    if (end > start + 1) {
      return (
        redisCrc16(new TextEncoder().encode(wireKey.slice(start + 1, end))) &
        0x3fff
      );
    }
  }
  return redisCrc16(new TextEncoder().encode(wireKey)) & 0x3fff;
}

describe("createElastiCacheCacheStore", () => {
  for (const testCase of conformanceCases) {
    it(testCase.name, async () => {
      const clock = createControllableClock(START);
      const logger = noopLogger;
      const keyPrefix = nextPrefix();
      await testCase.run({
        clock,
        logger,
        createStore: () =>
          createElastiCacheCacheStore({ clock, logger, redis, keyPrefix }),
        createUnavailableStore: () =>
          createElastiCacheCacheStore({
            clock,
            logger,
            redis: unavailableRedis(),
            keyPrefix,
          }),
      });
    });
  }
});

describe("ElastiCache adapter composition", () => {
  it("shares the generic Redis envelope and tag index", async () => {
    const clock = createControllableClock(START);
    const keyPrefix = nextPrefix();
    const elasticache = createElastiCacheCacheStore({
      clock,
      redis,
      keyPrefix,
    });
    const generic = createRedisCacheStore({ clock, redis, keyPrefix });
    const codec = jsonCodec<string>();
    const address = { namespace: "ns", key: "shared" };
    await elasticache.set(address, "value", codec, { tags: ["group"] });
    expect(await generic.get(address, codec)).toMatchObject({
      status: "hit",
      value: "value",
    });
    expect(await generic.invalidateTags(["group"])).toEqual({
      status: "hit",
      value: 1,
    });
    expect(await elasticache.get(address, codec)).toEqual({ status: "miss" });
  });

  it("keeps the CacheKey hash tag as the first brace pair on the wire", async () => {
    const clock = createControllableClock(START);
    const keyPrefix = nextPrefix();
    const store = createElastiCacheCacheStore({ clock, redis, keyPrefix });
    const codec = jsonCodec<string>();
    await store.set(
      { namespace: "sessions", key: "one", hashTag: "user-1" },
      "tagged",
      codec,
    );
    expect(
      await redis.getBuffer(`${keyPrefix}e:{user-1}sessions:one`),
    ).not.toBeNull();
  });

  it("rejects a keyPrefix that would steal the hash tag", () => {
    expect(() =>
      createElastiCacheCacheStore({
        clock: createControllableClock(START),
        redis,
        keyPrefix: "pre{fix}:",
      }),
    ).toThrow(/braces/u);
  });
});

describe("ElastiCache cluster hash-tag colocation", () => {
  it("matches Redis CLUSTER KEYSLOT on published vectors", () => {
    expect(redisClusterSlot("foo")).toBe(12182);
    expect(redisClusterSlot("somekey")).toBe(11058);
    expect(redisClusterSlot("foo{hash_tag}")).toBe(2515);
    expect(redisClusterSlot("bar{hash_tag}")).toBe(2515);
    expect(redisClusterSlot("{user1000}.following")).toBe(
      redisClusterSlot("{user1000}.followers"),
    );
  });

  it("embeds {tag} so tagged wire keys share a Redis Cluster slot", async () => {
    const clock = createControllableClock(START);
    const keyPrefix = nextPrefix();
    const store = createElastiCacheCacheStore({ clock, redis, keyPrefix });
    const codec = jsonCodec<string>();
    const first = { namespace: "sessions", key: "one", hashTag: "user-1" };
    const second = { namespace: "profile", key: "two", hashTag: "user-1" };
    const other = { namespace: "sessions", key: "one", hashTag: "user-2" };

    expect(formatCacheKey(first)).toBe("{user-1}sessions:one");
    expect(formatCacheKey(second)).toBe("{user-1}profile:two");
    expect(formatCacheKey(other)).toBe("{user-2}sessions:one");

    await store.set(first, "a", codec);
    await store.set(second, "b", codec);
    await store.set(other, "c", codec);

    const firstWire = `${keyPrefix}e:{user-1}sessions:one`;
    const secondWire = `${keyPrefix}e:{user-1}profile:two`;
    const otherWire = `${keyPrefix}e:{user-2}sessions:one`;
    expect(await redis.getBuffer(firstWire)).not.toBeNull();
    expect(await redis.getBuffer(secondWire)).not.toBeNull();
    expect(await redis.getBuffer(otherWire)).not.toBeNull();

    expect(redisClusterSlot(firstWire)).toBe(redisClusterSlot(secondWire));
    expect(redisClusterSlot(firstWire)).toBe(redisClusterSlot("{user-1}"));
    expect(redisClusterSlot(firstWire)).not.toBe(redisClusterSlot(otherWire));
    expect(keyPrefix.includes("{") || keyPrefix.includes("}")).toBe(false);
  });
});
