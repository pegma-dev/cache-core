import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createControllableClock, jsonCodec } from "@pegma/cache-core";
import { conformanceCases } from "@pegma/cache-conformance";
import {
  createRedisCacheStore,
  type RedisCacheClient,
} from "@pegma/cache-redis";
import { noopLogger } from "@pegma/spine";

import { REDIS_URL } from "../../../tests/redis-server.js";
import { createAzureRedisCacheStore } from "./index.js";

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
  return `pegma-cache:az${String(process.pid)}:${String(prefixCounter)}:`;
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

describe("createAzureRedisCacheStore", () => {
  for (const testCase of conformanceCases) {
    it(testCase.name, async () => {
      const clock = createControllableClock(START);
      const logger = noopLogger;
      const keyPrefix = nextPrefix();
      await testCase.run({
        clock,
        logger,
        createStore: () =>
          createAzureRedisCacheStore({ clock, logger, redis, keyPrefix }),
        createUnavailableStore: () =>
          createAzureRedisCacheStore({
            clock,
            logger,
            redis: unavailableRedis(),
            keyPrefix,
          }),
      });
    });
  }
});

describe("Azure Redis adapter composition", () => {
  it("shares the generic Redis envelope and tag index", async () => {
    const clock = createControllableClock(START);
    const keyPrefix = nextPrefix();
    const azure = createAzureRedisCacheStore({ clock, redis, keyPrefix });
    const generic = createRedisCacheStore({ clock, redis, keyPrefix });
    const codec = jsonCodec<string>();
    const address = { namespace: "ns", key: "shared" };
    await azure.set(address, "value", codec, { tags: ["group"] });
    expect(await generic.get(address, codec)).toMatchObject({
      status: "hit",
      value: "value",
    });
    expect(await generic.invalidateTags(["group"])).toEqual({
      status: "hit",
      value: 1,
    });
    expect(await azure.get(address, codec)).toEqual({ status: "miss" });
  });

  it("keeps the CacheKey hash tag as the first brace pair on the wire", async () => {
    const clock = createControllableClock(START);
    const keyPrefix = nextPrefix();
    const store = createAzureRedisCacheStore({ clock, redis, keyPrefix });
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
      createAzureRedisCacheStore({
        clock: createControllableClock(START),
        redis,
        keyPrefix: "pre{fix}:",
      }),
    ).toThrow(/braces/u);
  });
});
