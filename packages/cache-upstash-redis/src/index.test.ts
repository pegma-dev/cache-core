import { Redis } from "ioredis";
import { Redis as UpstashRedis } from "@upstash/redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createControllableClock, jsonCodec } from "@pegma/cache-core";
import { conformanceCases } from "@pegma/cache-conformance";
import { noopLogger } from "@pegma/spine";

import { REDIS_URL } from "../../../tests/redis-server.js";
import {
  createUpstashRedisCacheStore,
  type UpstashRedisCacheClient,
} from "./index.js";

const START = "2026-08-15T16:00:00.000Z";

const tcp = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 1,
});

/**
 * `@upstash/redis` speaks HTTP REST, not the Redis protocol, so it cannot
 * use the CI Redis service. This stand-in is that client's command surface
 * over the same Redis the other adapters use. A live Upstash pair in
 * `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` replaces it.
 */
function createRedisStandIn(client: Redis): UpstashRedisCacheClient {
  return {
    get: (key) => client.get(key),
    set: (key, value) => client.set(key, String(value)),
    del: (...keys) => client.del(...keys),
    sadd: (key, ...members) => client.sadd(key, ...members),
    srem: (key, ...members) => client.srem(key, ...members),
    smembers: (key) => client.smembers(key),
    ping: () => client.ping(),
    eval: (script, keys, args) =>
      client.eval(
        script,
        keys.length,
        ...keys,
        ...args.map((arg) => {
          if (typeof arg === "string" || typeof arg === "number") {
            return arg;
          }
          return String(arg);
        }),
      ),
  };
}

function createLiveUpstashClient(): UpstashRedisCacheClient | undefined {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url === undefined || token === undefined || url === "" || token === "") {
    return undefined;
  }
  return new UpstashRedis({ url, token });
}

const redis = createLiveUpstashClient() ?? createRedisStandIn(tcp);

beforeAll(async () => {
  await redis.ping();
});

afterAll(async () => {
  await tcp.quit();
});

let prefixCounter = 0;

function nextPrefix(): string {
  prefixCounter += 1;
  return `pegma-cache:up${String(process.pid)}:${String(prefixCounter)}:`;
}

function unavailableUpstash(): UpstashRedisCacheClient {
  const down = new Error("cache backend unavailable");
  const reject = async (): Promise<never> => {
    throw down;
  };
  return {
    get: reject,
    set: reject,
    del: reject,
    sadd: reject,
    srem: reject,
    smembers: reject,
    ping: reject,
    eval: reject,
  };
}

describe("createUpstashRedisCacheStore", () => {
  for (const testCase of conformanceCases) {
    it(testCase.name, async () => {
      const clock = createControllableClock(START);
      const logger = noopLogger;
      const keyPrefix = nextPrefix();
      await testCase.run({
        clock,
        logger,
        createStore: () =>
          createUpstashRedisCacheStore({ clock, logger, redis, keyPrefix }),
        createUnavailableStore: () =>
          createUpstashRedisCacheStore({
            clock,
            logger,
            redis: unavailableUpstash(),
            keyPrefix,
          }),
      });
    });
  }
});

describe("Upstash Redis adapter", () => {
  it("accepts the @upstash/redis client type at the composition root", () => {
    const client = new UpstashRedis({
      url: "https://example.upstash.io",
      token: "test",
    });
    expect(() =>
      createUpstashRedisCacheStore({
        clock: createControllableClock(START),
        redis: client,
      }),
    ).not.toThrow();
  });

  it("shares entries and tag index across store handles", async () => {
    const clock = createControllableClock(START);
    const keyPrefix = nextPrefix();
    const first = createUpstashRedisCacheStore({ clock, redis, keyPrefix });
    const second = createUpstashRedisCacheStore({ clock, redis, keyPrefix });
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

  it("keeps the CacheKey hash tag as the first brace pair on the wire", async () => {
    const clock = createControllableClock(START);
    const keyPrefix = nextPrefix();
    const store = createUpstashRedisCacheStore({ clock, redis, keyPrefix });
    const codec = jsonCodec<string>();
    await store.set(
      { namespace: "sessions", key: "one", hashTag: "user-1" },
      "tagged",
      codec,
    );
    expect(
      await redis.get(`${keyPrefix}e:{user-1}sessions:one`),
    ).not.toBeNull();
  });

  it("calls eval with the Upstash keys-and-args signature", async () => {
    const clock = createControllableClock(START);
    const keyPrefix = nextPrefix();
    const codec = jsonCodec<string>();
    const address = { namespace: "ttl", key: "slide" };
    let seen: { keys: string[]; args: unknown[] } | undefined;
    const observing: UpstashRedisCacheClient = {
      get: (key) => redis.get(key),
      set: (key, value) => redis.set(key, value),
      del: (...keys) => redis.del(...keys),
      sadd: (key, ...members) => redis.sadd(key, ...members),
      srem: (key, ...members) => redis.srem(key, ...members),
      smembers: (key) => redis.smembers(key),
      ping: () => redis.ping(),
      async eval(script, keys, args) {
        const argv = [...args];
        seen = { keys, args: argv };
        return redis.eval(script, keys, argv);
      },
    };
    const store = createUpstashRedisCacheStore({
      clock,
      redis: observing,
      keyPrefix,
    });
    await store.set(address, "old", codec, { ttl: { slidingMs: 1_000 } });
    clock.advance(600);
    expect(await store.get(address, codec)).toMatchObject({
      status: "hit",
      value: "old",
    });
    expect(seen?.keys).toEqual([`${keyPrefix}e:ttl:slide`]);
    expect(seen?.args).toHaveLength(2);
    expect(typeof seen?.args[0]).toBe("string");
    expect(typeof seen?.args[1]).toBe("string");
  });

  it("rejects a keyPrefix that would steal the hash tag", () => {
    expect(() =>
      createUpstashRedisCacheStore({
        clock: createControllableClock(START),
        redis,
        keyPrefix: "pre{fix}:",
      }),
    ).toThrow(/braces/u);
  });
});
