# `@pegma/cache-redis`

Generic Redis adapter for [`@pegma/cache-core`](https://github.com/pegma-dev/cache-core).
Intended future hosts: RetireGolden.org and Exsimplify.

> [!IMPORTANT]
> Pegma is in early `0.x` development. This package's public API is unstable.

```ts
import { createControllableClock, jsonCodec } from "@pegma/cache-core";
import { createRedisCacheStore } from "@pegma/cache-redis";
import Redis from "ioredis";

const clock = createControllableClock("2026-08-15T16:00:00.000Z");
const cache = createRedisCacheStore({
  clock,
  redis: new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379"),
});
const codec = jsonCodec<string>();

const result = await cache.getOrCompute(
  { namespace: "sessions", key: "abc", hashTag: "user-1" },
  {
    codec,
    ttl: { absoluteMs: 60_000 },
    fallback: "fail-open",
    compute: () => loadSession(),
  },
);
```

Hosts depend on `CacheStore`. Construct the Redis client at the composition
root and hand it to this adapter; application code does not import `ioredis`.

TTL, sliding refresh, and XFetch read the injected Spine `Clock`. Redis
`EXPIRE` is not the source of truth, so a test clock can pin expiry. Tag
invalidation uses a sidecar index in Redis — one key at a time, never an
implicit multi-key command. Hash tags stay formatting: `{tag}` in the wire
key from `formatCacheKey`.

This adapter passes `@pegma/cache-conformance` against a real Redis.
