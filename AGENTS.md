# Working in this repository

Read this before changing anything. It is short on purpose.

## What this is part of

Cache Core is the ephemeral-caching component of **Pegma**, a family of
MIT-licensed packages a host application composes. Shared time and logging
contracts live in `@pegma/spine`. Durable state belongs in
`@pegma/storage-core` — this repository refuses that job. One repository per
component, publishing under the `@pegma` scope.

The governing principle, which every rule below follows from:

> **Optimize for a fresh agent context window.** How much must be read to make
> a correct change, and how does the change prove itself correct? Minimize the
> first, mechanize the second.

A cache that lies about freshness, stamps over a neighbor's namespace, or
falls back to unbounded local memory when Redis is down is worse than no
cache. Weigh changes accordingly.

## Hard rules

**The conformance suite is the specification.** A behaviour that is not
asserted in `@pegma/cache-conformance` is not something a host or adapter may
rely on. Add cases with the behaviour, never after.

**Injected Clock and Logger only.** TTL, sliding expiry, and XFetch read
`clock.now()`. Never call `Date.now()` on a production path. Log outcomes
coarsely (namespace, status) — never keys, values, or customer content.

**Namespaces are strict.** `formatCacheKey` is the only legal wire form.
Redis Cluster hash tags are in the contract (`hashTag` becomes `{tag}` in
the formatted key). Do not invent implicit cross-partition multi-key ops.

**Single-flight is process-local honesty.** N parallel misses for one key
must run `compute` exactly once in that process. Do not pretend this is a
distributed lock.

**Fail-open computes; fail-closed refuses.** When the backend errors, a
`fail-open` `getOrCompute` still runs `compute` and returns the value. A
`fail-closed` call returns `error` and does not compute. Never install an
unbounded in-process map as a fallback when the remote cache is down.

**No vendor clients in application code.** Adapters wrap Redis, Azure Cache,
ElastiCache, or Upstash. Hosts depend on `CacheStore`. Do not create an
adapter package until implementation begins and a named consumer exists.
`@pegma/cache-redis` exists because RetireGolden.org and Exsimplify are
named future hosts.

**This is not durable state.** Persistence, optimistic concurrency, and
transactions belong in `@pegma/storage-core`. A cache miss is not data loss.

**Pin `@pegma/*` deps exactly.** A caret would let CI resolve a version
nobody tested against.

**Never write literal control characters into source.** Write them as escape
sequences such as backslash-u-0000 through backslash-u-001F, and verify the
bytes after any tool-assisted edit.

## Packaging traps already paid for

Each published package needs its **own** README and LICENSE inside the package
directory; npm ignores files at the repository root. Each needs `prepack`
running the build. Each package `tsconfig.json` must exclude
`src/**/*.test.ts`, or compiled tests ship to consumers.

`runNpm` / release scripts must invoke a real npm CLI. Ignore `npm_execpath`
when pnpm set it, or pack/publish silently go through pnpm.

## Workflow

Work on a `claude/*` branch and open a pull request. The gate is
`pnpm run format:check`, `pnpm run check`, `pnpm test` — all three, on Node 22
and 24. Changes to `@pegma/cache-redis` also run `pnpm run test:redis`
against a real Redis (CI starts one; locally `redis-server` on port 16379
or a service already bound there). Changes to `@pegma/cache-azure-redis`
also run `pnpm run test:azure-redis` against the same Redis.

Publishing is trusted-publisher only; no tokens exist. A release starts from a
protected signed annotated `vX.Y.Z` tag already on `origin/main`, followed by
`gh release create vX.Y.Z --verify-tag`. See `docs/RELEASING.md`.

## Where things stand

Phase 3: `@pegma/cache-core`, `@pegma/cache-conformance`,
`@pegma/cache-redis`, and `@pegma/cache-azure-redis` (thin composition of
the generic Redis adapter). ElastiCache / Upstash adapters are later
phases — do not create those packages here yet.

Siblings: [spine](https://github.com/pegma-dev/spine),
[storage-core](https://github.com/pegma-dev/storage-core),
[health](https://github.com/pegma-dev/health).
