# `@pegma/cache-azure-redis`

Azure Cache for Redis adapter for [`@pegma/cache-core`](https://github.com/pegma-dev/cache-core).
A thin composition of [`@pegma/cache-redis`](https://github.com/pegma-dev/cache-core/tree/main/packages/cache-redis):
Azure Cache for Redis speaks Redis, so this package does not invent a second
store. Intended future hosts: RetireGolden.org and Exsimplify.

> [!IMPORTANT]
> Pegma is in early `0.x` development. This package's public API is unstable.

```ts
import { createControllableClock, jsonCodec } from "@pegma/cache-core";
import { createAzureRedisCacheStore } from "@pegma/cache-azure-redis";
import { Redis } from "ioredis";

const clock = createControllableClock("2026-08-15T16:00:00.000Z");
const cache = createAzureRedisCacheStore({
  clock,
  redis: new Redis({
    host: process.env.AZURE_REDIS_HOST ?? "127.0.0.1",
    port: Number(process.env.AZURE_REDIS_PORT ?? "6380"),
    password: process.env.AZURE_REDIS_ACCESS_KEY,
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
root — typically TLS on port 6380 with the Azure access key as the password —
and hand it to this adapter. Application code does not import `ioredis`.

There is no Azure data-plane Redis SDK to wrap. This factory forwards to
`createRedisCacheStore`, so TTL, sliding refresh, and XFetch still read the
injected Spine `Clock`, tag invalidation still uses a sidecar index, and hash
tags stay formatting.

This adapter passes `@pegma/cache-conformance` against a real Redis.
