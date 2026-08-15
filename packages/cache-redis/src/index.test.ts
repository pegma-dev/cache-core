import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createControllableClock, jsonCodec } from "@pegma/cache-core";
import { conformanceCases } from "@pegma/cache-conformance";
import { noopLogger } from "@pegma/spine";

import { REDIS_URL } from "../../../tests/redis-server.js";
import { createRedisCacheStore, type RedisCacheClient } from "./index.js";

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
  return `pegma-cache:t${String(process.pid)}:${String(prefixCounter)}:`;
}

function proxyRedis(
  client: Redis,
  hooks: {
    afterGetBuffer?: () => Promise<void>;
  } = {},
): RedisCacheClient {
  return {
    async getBuffer(key) {
      const raw = await client.getBuffer(key);
      await hooks.afterGetBuffer?.();
      return raw;
    },
    set: (key, value) => client.set(key, value),
    del: (...keys) => client.del(...keys),
    sadd: (key, ...members) => client.sadd(key, ...members),
    srem: (key, ...members) => client.srem(key, ...members),
    smembers: (key) => client.smembers(key),
    ping: () => client.ping(),
    eval: (script, numKeys, ...args) => client.eval(script, numKeys, ...args),
  };
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

describe("createRedisCacheStore", () => {
  for (const testCase of conformanceCases) {
    it(testCase.name, async () => {
      const clock = createControllableClock(START);
      const logger = noopLogger;
      const keyPrefix = nextPrefix();
      await testCase.run({
        clock,
        logger,
        createStore: () =>
          createRedisCacheStore({ clock, logger, redis, keyPrefix }),
        createUnavailableStore: () =>
          createRedisCacheStore({
            clock,
            logger,
            redis: unavailableRedis(),
            keyPrefix,
          }),
      });
    });
  }
});

describe("Redis adapter guarantees", () => {
  it("shares entries and tag index across store handles", async () => {
    const clock = createControllableClock(START);
    const keyPrefix = nextPrefix();
    const first = createRedisCacheStore({ clock, redis, keyPrefix });
    const second = createRedisCacheStore({ clock, redis, keyPrefix });
    const codec = jsonCodec<string>();
    const address = { namespace: "ns", key: "shared" };
    await first.set(address, "value", codec, { tags: ["group"] });
    expect(await second.get(address, codec)).toMatchObject({
      status: "hit",
      value: "value",
    });
    expect(await second.invalidateTags(["group"])).toEqual({
      status: "hit",
      value: 1,
    });
    expect(await first.get(address, codec)).toEqual({ status: "miss" });
  });

  it("does not let a later tag-array mutation poison the index", async () => {
    const clock = createControllableClock(START);
    const store = createRedisCacheStore({
      clock,
      redis,
      keyPrefix: nextPrefix(),
    });
    const codec = jsonCodec<string>();
    const address = { namespace: "tags", key: "row" };
    const tags = ["group"];
    await store.set(address, "v1", codec, { tags });
    tags[0] = "mutated";
    await store.delete(address);
    await store.set(address, "v2", codec);
    expect(await store.invalidateTags(["group"])).toEqual({
      status: "hit",
      value: 0,
    });
    expect(await store.get(address, codec)).toMatchObject({
      status: "hit",
      value: "v2",
    });
  });

  it("keeps the previous entry indexed when encode throws", async () => {
    const clock = createControllableClock(START);
    const store = createRedisCacheStore({
      clock,
      redis,
      keyPrefix: nextPrefix(),
    });
    const codec = jsonCodec<string>();
    const address = { namespace: "tags", key: "row" };
    await store.set(address, "v1", codec, { tags: ["group"] });
    const exploding: typeof codec = {
      encode() {
        throw new Error("cannot encode");
      },
      decode() {
        throw new Error("unused");
      },
    };
    await expect(
      store.set(address, "v2", exploding, { tags: ["other"] }),
    ).rejects.toThrow("cannot encode");
    expect(await store.get(address, codec)).toMatchObject({
      status: "hit",
      value: "v1",
    });
    expect(await store.invalidateTags(["group"])).toEqual({
      status: "hit",
      value: 1,
    });
    expect(await store.get(address, codec)).toEqual({ status: "miss" });
  });

  it("treats delete of an expired entry as a miss and purges it", async () => {
    const clock = createControllableClock(START);
    const store = createRedisCacheStore({
      clock,
      redis,
      keyPrefix: nextPrefix(),
    });
    const codec = jsonCodec<string>();
    const address = { namespace: "ttl", key: "stale" };
    await store.set(address, "old", codec, {
      ttl: { absoluteMs: 1_000 },
      tags: ["group"],
    });
    clock.advance(1_000);
    expect(await store.delete(address)).toEqual({
      status: "hit",
      value: false,
    });
    expect(await store.get(address, codec)).toEqual({ status: "miss" });
    expect(await store.invalidateTags(["group"])).toEqual({
      status: "hit",
      value: 0,
    });
  });

  it("recomputes under XFetch when the random draw says so", async () => {
    const clock = createControllableClock(START);
    const store = createRedisCacheStore({
      clock,
      redis,
      keyPrefix: nextPrefix(),
      random: () => 0.5,
    });
    const codec = jsonCodec<string>();
    const address = { namespace: "xfetch", key: "hot" };
    let computes = 0;
    const first = await store.getOrCompute(address, {
      codec,
      ttl: { absoluteMs: 60_000 },
      earlyExpiration: { beta: 1 },
      compute: () => {
        computes += 1;
        clock.advance(50);
        return `v${String(computes)}`;
      },
    });
    expect(first).toMatchObject({ status: "hit", value: "v1" });
    clock.advance(59_980);
    const second = await store.getOrCompute(address, {
      codec,
      ttl: { absoluteMs: 60_000 },
      earlyExpiration: { beta: 1 },
      compute: () => {
        computes += 1;
        return `v${String(computes)}`;
      },
    });
    expect(computes).toBe(2);
    expect(second).toMatchObject({ status: "hit", value: "v2" });
  });

  it("keeps the CacheKey hash tag as the first brace pair on the wire", async () => {
    const clock = createControllableClock(START);
    const keyPrefix = nextPrefix();
    const store = createRedisCacheStore({ clock, redis, keyPrefix });
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

  it("does not let a sliding refresh restore a concurrently written value", async () => {
    const clock = createControllableClock(START);
    const keyPrefix = nextPrefix();
    const codec = jsonCodec<string>();
    const address = { namespace: "ttl", key: "race" };
    const writer = createRedisCacheStore({ clock, redis, keyPrefix });
    await writer.set(address, "old", codec, { ttl: { slidingMs: 1_000 } });
    clock.advance(600);

    let releaseRead = (): void => {};
    const holdRead = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let sawRead = (): void => {};
    const startedRead = new Promise<void>((resolve) => {
      sawRead = resolve;
    });
    const reader = createRedisCacheStore({
      clock,
      redis: proxyRedis(redis, {
        async afterGetBuffer() {
          sawRead();
          await holdRead;
        },
      }),
      keyPrefix,
    });

    const pending = reader.get(address, codec);
    await startedRead;
    await writer.set(address, "new", codec, { ttl: { slidingMs: 1_000 } });
    releaseRead();
    await pending;
    expect(await writer.get(address, codec)).toMatchObject({
      status: "hit",
      value: "new",
    });
  });

  it("does not delete a winning entry when a stale tag is invalidated", async () => {
    const clock = createControllableClock(START);
    const keyPrefix = nextPrefix();
    const codec = jsonCodec<string>();
    const address = { namespace: "tags", key: "race" };

    let reads = 0;
    let releaseReads = (): void => {};
    const bothRead = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    const afterGetBuffer = async (): Promise<void> => {
      reads += 1;
      if (reads === 2) {
        releaseReads();
      }
      await bothRead;
    };

    const first = createRedisCacheStore({
      clock,
      redis: proxyRedis(redis, { afterGetBuffer }),
      keyPrefix,
    });
    const second = createRedisCacheStore({
      clock,
      redis: proxyRedis(redis, { afterGetBuffer }),
      keyPrefix,
    });

    await Promise.all([
      first.set(address, "alpha", codec, { tags: ["alpha"] }),
      second.set(address, "beta", codec, { tags: ["beta"] }),
    ]);

    const observer = createRedisCacheStore({ clock, redis, keyPrefix });
    const current = await observer.get(address, codec);
    expect(current.status).toBe("hit");
    if (current.status !== "hit") {
      return;
    }
    const winner = current.value;
    const staleTag = winner === "alpha" ? "beta" : "alpha";
    expect(await observer.invalidateTags([staleTag])).toEqual({
      status: "hit",
      value: 0,
    });
    expect(await observer.get(address, codec)).toMatchObject({
      status: "hit",
      value: winner,
    });
  });

  it("rejects a keyPrefix that would steal the hash tag", () => {
    expect(() =>
      createRedisCacheStore({
        clock: createControllableClock(START),
        redis,
        keyPrefix: "pre{fix}:",
      }),
    ).toThrow(/braces/u);
  });
});
