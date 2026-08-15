import { describe, expect, it } from "vitest";

import {
  CacheKeyValidationError,
  bytesCodec,
  createControllableClock,
  createMemoryCacheStore,
  createSingleFlight,
  formatCacheKey,
  jsonCodec,
  shouldExpireEarly,
} from "./index.js";

const START = "2026-08-15T16:00:00.000Z";

describe("formatCacheKey", () => {
  it("joins namespace and key", () => {
    expect(formatCacheKey({ namespace: "sessions", key: "abc" })).toBe(
      "sessions:abc",
    );
  });

  it("embeds a Redis Cluster hash tag", () => {
    expect(
      formatCacheKey({
        namespace: "sessions",
        key: "abc",
        hashTag: "user-1",
      }),
    ).toBe("{user-1}sessions:abc");
  });

  it("rejects an empty namespace", () => {
    expect(() => formatCacheKey({ namespace: "", key: "a" })).toThrow(
      CacheKeyValidationError,
    );
  });

  it("rejects a colon in the namespace", () => {
    expect(() => formatCacheKey({ namespace: "a:b", key: "c" })).toThrow(
      CacheKeyValidationError,
    );
  });

  it("rejects a control character in the key", () => {
    expect(() =>
      formatCacheKey({ namespace: "ns", key: `bad\u0000key` }),
    ).toThrow(CacheKeyValidationError);
  });
});

describe("codecs", () => {
  it("round-trips JSON", () => {
    const codec = jsonCodec<{ readonly n: number }>();
    expect(codec.decode(codec.encode({ n: 3 }))).toEqual({ n: 3 });
  });

  it("copies bytes so later mutation is invisible", () => {
    const input = new Uint8Array([1, 2, 3]);
    const stored = bytesCodec.encode(input);
    input[0] = 9;
    expect([...bytesCodec.decode(stored)]).toEqual([1, 2, 3]);
  });
});

describe("createSingleFlight", () => {
  it("coalesces concurrent work for one key", async () => {
    const flight = createSingleFlight();
    let runs = 0;
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = [
      flight.do("k", async () => {
        runs += 1;
        await gate;
        return "one";
      }),
      flight.do("k", async () => {
        runs += 1;
        return "two";
      }),
    ];
    release();
    expect(await Promise.all(pending)).toEqual(["one", "one"]);
    expect(runs).toBe(1);
  });
});

describe("shouldExpireEarly", () => {
  it("is more likely near expiry", () => {
    expect(
      shouldExpireEarly({
        nowMs: 999,
        expiresAtMs: 1_000,
        lastComputeMs: 50,
        beta: 1,
        random: () => 0.5,
      }),
    ).toBe(true);
    expect(
      shouldExpireEarly({
        nowMs: 0,
        expiresAtMs: 1_000_000,
        lastComputeMs: 1,
        beta: 1,
        random: () => 0.5,
      }),
    ).toBe(false);
  });
});

describe("createMemoryCacheStore", () => {
  it("gives each store its own records", async () => {
    const clock = createControllableClock(START);
    const first = createMemoryCacheStore({ clock });
    const second = createMemoryCacheStore({ clock });
    const codec = jsonCodec<string>();
    await first.set({ namespace: "ns", key: "only" }, "secret", codec);
    expect(await second.get({ namespace: "ns", key: "only" }, codec)).toEqual({
      status: "miss",
    });
  });

  it("recomputes under XFetch when the random draw says so", async () => {
    const clock = createControllableClock(START);
    const store = createMemoryCacheStore({
      clock,
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
        return `v${computes}`;
      },
    });
    expect(first).toMatchObject({ status: "hit", value: "v1" });
    // Remaining TTL is ~20ms; with beta=1, delta=50, random=0.5, XFetch fires.
    clock.advance(59_980);
    const second = await store.getOrCompute(address, {
      codec,
      ttl: { absoluteMs: 60_000 },
      earlyExpiration: { beta: 1 },
      compute: () => {
        computes += 1;
        return `v${computes}`;
      },
    });
    expect(computes).toBe(2);
    expect(second).toMatchObject({ status: "hit", value: "v2" });
  });
});
