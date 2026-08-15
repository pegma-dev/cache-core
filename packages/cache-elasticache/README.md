# `@pegma/cache-elasticache`

Amazon ElastiCache adapter for [`@pegma/cache-core`](https://github.com/pegma-dev/cache-core).
A thin composition of [`@pegma/cache-redis`](https://github.com/pegma-dev/cache-core/tree/main/packages/cache-redis):
ElastiCache speaks Redis, so this package does not invent a second store.
Intended future hosts: RetireGolden.org and Exsimplify.

> [!IMPORTANT]
> Pegma is in early `0.x` development. This package's public API is unstable.

```ts
import { createControllableClock, jsonCodec } from "@pegma/cache-core";
import { createElastiCacheCacheStore } from "@pegma/cache-elasticache";
import { Redis } from "ioredis";

const clock = createControllableClock("2026-08-15T16:00:00.000Z");
const cache = createElastiCacheCacheStore({
  clock,
  redis: new Redis({
    host: process.env.ELASTICACHE_HOST ?? "127.0.0.1",
    port: Number(process.env.ELASTICACHE_PORT ?? "6379"),
    password: process.env.ELASTICACHE_AUTH_TOKEN,
    tls: {},
  }),
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
root — typically TLS to the primary or configuration endpoint, with the
ElastiCache AUTH token as the password — and hand it to this adapter.
Application code does not import `ioredis` or an AWS data-plane SDK.

There is no ElastiCache data-plane Redis SDK to wrap. This factory forwards
to `createRedisCacheStore`, so TTL, sliding refresh, and XFetch still read
the injected Spine `Clock`, tag invalidation still uses a sidecar index, and
hash tags stay formatting. `formatCacheKey` embeds `{tag}` as the first
brace pair on the wire so Redis Cluster (and ElastiCache cluster mode)
colocates those keys. The port still refuses implicit cross-partition
multi-key operations.

This adapter passes `@pegma/cache-conformance` against a real Redis.
