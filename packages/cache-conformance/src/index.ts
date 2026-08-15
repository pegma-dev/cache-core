import assert from "node:assert/strict";

import {
  createUnavailableCacheStore,
  formatCacheKey,
  jsonCodec,
  type CacheKey,
  type CacheStore,
  type ControllableClock,
} from "@pegma/cache-core";
import { noopLogger, type Logger } from "@pegma/spine";

/**
 * The behaviour every {@link CacheStore} implementation must exhibit.
 *
 * These cases are the specification. An adapter is finished when it passes
 * them, and a behaviour that is not asserted here is not something a
 * host may rely on.
 *
 * The suite has no test-framework dependency so that it can run under
 * whatever runner an adapter already uses:
 *
 * ```ts
 * for (const testCase of conformanceCases) {
 *   it(testCase.name, () => testCase.run(context));
 * }
 * ```
 */
export interface ConformanceContext {
  readonly clock: ControllableClock;
  readonly logger: Logger;
  /**
   * Stores returned during one case must share one initially empty physical
   * backend. Adapters should return a fresh handle per call so cases prove
   * that guarantees do not depend on process-local state, unless the factory
   * intentionally reuses one backend for multi-instance checks.
   */
  createStore(): CacheStore;
  /**
   * A store whose get/set/delete/ping fail. Memory uses
   * {@link createUnavailableCacheStore}; adapters should point at a downed
   * backend. Used only by fail-open / fail-closed cases.
   */
  createUnavailableStore(): CacheStore;
}

export interface ConformanceCase {
  readonly name: string;
  run(context: ConformanceContext): Promise<void>;
}

const codec = jsonCodec<string>();

function key(namespace: string, id: string, hashTag?: string): CacheKey {
  return hashTag === undefined
    ? { namespace, key: id }
    : { namespace, key: id, hashTag };
}

function testCase(
  name: string,
  run: (store: CacheStore, context: ConformanceContext) => Promise<void>,
): ConformanceCase {
  return { name, run: (context) => run(context.createStore(), context) };
}

export const conformanceCases: readonly ConformanceCase[] = [
  testCase(
    "get returns miss for a key that was never written",
    async (store) => {
      assert.deepEqual(await store.get(key("ns", "absent"), codec), {
        status: "miss",
      });
    },
  ),

  testCase("set then get round-trips through the codec", async (store) => {
    const address = key("widgets", "hammer");
    const written = await store.set(address, "claw", codec);
    assert.equal(written.status, "hit");
    const got = await store.get(address, codec);
    assert.equal(got.status, "hit");
    if (got.status === "hit") {
      assert.equal(got.value, "claw");
    }
  }),

  testCase("namespaces do not share records", async (store) => {
    await store.set(key("alpha", "shared"), "in-alpha", codec);
    assert.deepEqual(await store.get(key("beta", "shared"), codec), {
      status: "miss",
    });
    const got = await store.get(key("alpha", "shared"), codec);
    assert.equal(got.status, "hit");
    if (got.status === "hit") {
      assert.equal(got.value, "in-alpha");
    }
  }),

  testCase(
    "keys that share a separator character stay distinct",
    async (store) => {
      await store.set(key("a", "b:c"), "first", codec);
      await store.set(key("ab", "c"), "second", codec);
      const first = await store.get(key("a", "b:c"), codec);
      const second = await store.get(key("ab", "c"), codec);
      assert.equal(first.status, "hit");
      assert.equal(second.status, "hit");
      if (first.status === "hit" && second.status === "hit") {
        assert.equal(first.value, "first");
        assert.equal(second.value, "second");
      }
    },
  ),

  testCase(
    "hash tags change the formatted key without leaking",
    async (store) => {
      const tagged = key("sessions", "one", "user-1");
      const plain = key("sessions", "one");
      assert.equal(formatCacheKey(tagged), "{user-1}sessions:one");
      assert.equal(formatCacheKey(plain), "sessions:one");
      await store.set(tagged, "tagged", codec);
      assert.deepEqual(await store.get(plain, codec), { status: "miss" });
      const got = await store.get(tagged, codec);
      assert.equal(got.status, "hit");
      if (got.status === "hit") {
        assert.equal(got.value, "tagged");
      }
    },
  ),

  testCase(
    "absolute TTL expires against the injected Clock",
    async (store, context) => {
      const address = key("ttl", "absolute");
      await store.set(address, "fresh", codec, { ttl: { absoluteMs: 1_000 } });
      const before = await store.get(address, codec);
      assert.equal(before.status, "hit");
      context.clock.advance(1_001);
      assert.deepEqual(await store.get(address, codec), { status: "miss" });
    },
  ),

  testCase(
    "sliding TTL refreshes on get and still expires",
    async (store, context) => {
      const address = key("ttl", "sliding");
      await store.set(address, "fresh", codec, { ttl: { slidingMs: 1_000 } });
      context.clock.advance(600);
      const mid = await store.get(address, codec);
      assert.equal(mid.status, "hit");
      context.clock.advance(600);
      const still = await store.get(address, codec);
      assert.equal(still.status, "hit");
      context.clock.advance(1_001);
      assert.deepEqual(await store.get(address, codec), { status: "miss" });
    },
  ),

  testCase(
    "sliding TTL cannot extend past an absolute deadline",
    async (store, context) => {
      const address = key("ttl", "both");
      await store.set(address, "fresh", codec, {
        ttl: { absoluteMs: 1_000, slidingMs: 5_000 },
      });
      context.clock.advance(400);
      const mid = await store.get(address, codec);
      assert.equal(mid.status, "hit");
      context.clock.advance(700);
      assert.deepEqual(await store.get(address, codec), { status: "miss" });
    },
  ),

  {
    name: "N parallel misses run compute exactly once",
    async run(context) {
      const store = context.createStore();
      const address = key("flight", "hot");
      let computes = 0;
      let entered = (): void => {};
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release = (): void => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const pending = Array.from({ length: 8 }, () =>
        store.getOrCompute(address, {
          codec,
          compute: async () => {
            computes += 1;
            entered();
            await gate;
            return "computed";
          },
        }),
      );
      await started;
      await Promise.resolve();
      release();
      const results = await Promise.all(pending);
      assert.equal(computes, 1);
      for (const result of results) {
        assert.equal(result.status, "hit");
        if (result.status === "hit") {
          assert.equal(result.value, "computed");
        }
      }
    },
  },

  testCase("tag invalidation removes every tagged entry", async (store) => {
    await store.set(key("tags", "a"), "A", codec, { tags: ["group"] });
    await store.set(key("tags", "b"), "B", codec, { tags: ["group"] });
    await store.set(key("tags", "c"), "C", codec, { tags: ["other"] });
    const invalidated = await store.invalidateTags(["group"]);
    assert.equal(invalidated.status, "hit");
    if (invalidated.status === "hit") {
      assert.equal(invalidated.value, 2);
    }
    assert.deepEqual(await store.get(key("tags", "a"), codec), {
      status: "miss",
    });
    assert.deepEqual(await store.get(key("tags", "b"), codec), {
      status: "miss",
    });
    const kept = await store.get(key("tags", "c"), codec);
    assert.equal(kept.status, "hit");
    if (kept.status === "hit") {
      assert.equal(kept.value, "C");
    }
  }),

  {
    name: "fail-open computes when the backend errors",
    async run(context) {
      const store = context.createUnavailableStore();
      let computes = 0;
      const result = await store.getOrCompute(key("down", "item"), {
        codec,
        fallback: "fail-open",
        compute: () => {
          computes += 1;
          return "from-origin";
        },
      });
      assert.equal(computes, 1);
      assert.equal(result.status, "hit");
      if (result.status === "hit") {
        assert.equal(result.value, "from-origin");
      }
    },
  },

  {
    name: "fail-closed returns error and does not compute",
    async run(context) {
      const store = context.createUnavailableStore();
      let computes = 0;
      const result = await store.getOrCompute(key("down", "item"), {
        codec,
        fallback: "fail-closed",
        compute: () => {
          computes += 1;
          return "should-not-run";
        },
      });
      assert.equal(computes, 0);
      assert.equal(result.status, "error");
    },
  },

  testCase("delete reports whether a live entry was removed", async (store) => {
    const address = key("del", "one");
    await store.set(address, "x", codec);
    const first = await store.delete(address);
    assert.deepEqual(first, { status: "hit", value: true });
    assert.deepEqual(await store.get(address, codec), { status: "miss" });
    const second = await store.delete(address);
    assert.deepEqual(second, { status: "hit", value: false });
  }),

  testCase("ping succeeds on a live store", async (store) => {
    assert.deepEqual(await store.ping(), { status: "hit", value: true });
  }),
];

export function defaultUnavailableStore(
  context: Pick<ConformanceContext, "clock" | "logger">,
): CacheStore {
  return createUnavailableCacheStore({
    clock: context.clock,
    logger: context.logger ?? noopLogger,
  });
}
