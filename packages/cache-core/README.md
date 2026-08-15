# `@pegma/cache-core`

Provider-neutral ephemeral caching for Pegma hosts: namespaced keys,
schema-aware codecs, cache-aside `getOrCompute`, and an in-memory store.

> [!IMPORTANT]
> Pegma is in early `0.x` development. This package's public API is unstable.

```ts
import {
  createControllableClock,
  createMemoryCacheStore,
  jsonCodec,
} from "@pegma/cache-core";

const clock = createControllableClock("2026-08-15T16:00:00.000Z");
const cache = createMemoryCacheStore({ clock });
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

Hosts inject a Spine `Clock` and `Logger`. This package never creates a
network client. Durable state belongs in `@pegma/storage-core`.

Every adapter must pass `@pegma/cache-conformance`.
