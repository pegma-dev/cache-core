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
