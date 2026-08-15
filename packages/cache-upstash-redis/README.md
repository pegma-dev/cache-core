# `@pegma/cache-upstash-redis`

Upstash Redis adapter for [`@pegma/cache-core`](https://github.com/pegma-dev/cache-core).
Wraps the Upstash serverless Redis client (`@upstash/redis`): that client is
HTTP REST, not the ioredis TCP surface, so this package adapts the REST
command shape and reuses [`@pegma/cache-redis`](https://github.com/pegma-dev/cache-core/tree/main/packages/cache-redis)
store logic. It does not pretend the HTTP client is ioredis. Intended
future hosts: RetireGolden.org and Exsimplify.

> [!IMPORTANT]
> Pegma is in early `0.x` development. This package's public API is unstable.

```ts
import { createControllableClock, jsonCodec } from "@pegma/cache-core";
import { createUpstashRedisCacheStore } from "@pegma/cache-upstash-redis";
import { Redis } from "@upstash/redis";

const clock = createControllableClock("2026-08-15T16:00:00.000Z");
const cache = createUpstashRedisCacheStore({
  clock,
  redis: new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
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

Hosts depend on `CacheStore`. Construct the Upstash REST client at the
composition root and hand it to this adapter. Application code does not
import `@upstash/redis`.

TTL, sliding refresh, and XFetch still read the injected Spine `Clock`.
Tag invalidation still uses a sidecar index — one key at a time — and
hash tags stay formatting. Envelopes travel as base64 strings because the
REST client is JSON-over-HTTP, not a binary Redis connection.

This adapter passes `@pegma/cache-conformance`. CI has no live Upstash
account; the suite injects a client with the Upstash command surface
(`get` / `set` / `eval(script, keys, args)`) that talks to the same Redis
the other adapters use. Point `UPSTASH_REDIS_REST_URL` and
`UPSTASH_REDIS_REST_TOKEN` at a real Upstash database to run the same
cases through `@upstash/redis`.
