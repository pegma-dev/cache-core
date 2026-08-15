# Cache Core Project Plan

## Status

**Stage:** Phase 3 — Azure Cache for Redis adapter, in-tree, unpublished.
`@pegma/cache-core`, `@pegma/cache-conformance`, `@pegma/cache-redis`, and
`@pegma/cache-azure-redis` are `0.1.0` and not published.

**License:** MIT

**Time and logging:** injected `@pegma/spine` `Clock` and `Logger`, pinned
exactly. This component never creates a clock and never calls `Date.now()`
on a production path.

## Vision

Every host eventually caches something, and nearly all of them get the same
quiet parts wrong: keys that collide across tenants, a stampede when a hot
entry expires, a TTL that follows wall clocks the test suite cannot pin, and
a "temporary" in-process map that becomes the production fallback when Redis
is down. The failure is silent — stale reads, thundering herds, or an
unbounded memory leak — and it surfaces as a latency cliff or a support
ticket, never as a typed error.

One ephemeral-cache port, provider-agnostic, whose namespacing, single-flight
coalescing, clock-driven TTL, and fallback policy are the component — so a
host wires an adapter and gets the part everyone gets wrong, already right.

## Where it sits in the stack

Beside two components that deliberately refuse this job:
[`@pegma/storage-core`](https://github.com/pegma-dev/storage-core) persists
records and explicitly is not a cache; Spine supplies time and logging and
explicitly is not a store. The ephemeral read-through layer in the middle is
owned by nobody — this component is that middle. A typical host path:
request → **cache-core `getOrCompute`** → origin (storage, HTTP, or compute)
→ adapter (Redis or memory). Durable writes still go through storage-core.

## Fundamental model

**Cache key** — `{ namespace, key, hashTag? }`. `formatCacheKey` is the only
legal wire form. Namespaces do not share entries. A Redis Cluster hash tag,
when present, is embedded as `{tag}` so multi-key ops that a later adapter
opts into can colocate — they are never implied by the port.

**Cache result** — `hit | miss | error`. Expected absence is `miss`.
Infrastructure failure is `error`. A successful `getOrCompute` that had to
run `compute` still returns `hit` with the computed value: the caller asked
for a value, and received one.

**Codec** — schema-aware `encode` / `decode` over `Uint8Array`. JSON and
raw bytes ship as helpers; a host may supply its own. The store persists
bytes, not objects.

**TTL** — absolute, sliding, or both, measured against the injected Clock.
Sliding refresh cannot extend past an absolute deadline. Expiry is a cache
concern, not a durability concern.

**Single-flight** — process-local coalescing so N parallel misses for one
formatted key run `compute` exactly once. This is not a distributed lock
and must not be documented as one.

**XFetch** — optional probabilistic early expiration so a hot key can
recompute before the deadline and dodge a stampede. Beta is a caller
choice; the clock is still the injected one.

**Fallback policy** — `fail-open` computes when the backend errors;
`fail-closed` returns `error` and does not compute. Neither policy
installs an in-process map as a substitute store.

## Design decisions

### Ephemeral is the product

A cache miss is not data loss. Anything that must survive a process restart
or a flushed Redis belongs in storage-core. Refusing durability is what
keeps this port honest and implementable on every adapter.

### The suite is the specification

Siblings export conformance as a subpath of the core package
(`@pegma/storage-core/conformance`). This repository publishes
`@pegma/cache-conformance` as its own package because Nathan's spec named
it that way and later adapters will depend on the suite without pulling
the memory store into their production graph. The _shape_ matches the
siblings: framework-free `conformanceCases`, one empty backend per case.

### Hash tags are in the contract; multi-key ops are not

Redis Cluster requires a hash tag for any atomic multi-key command. The
key type carries `hashTag` so an adapter can format `{tag}namespace:key`.
The port still refuses implicit cross-partition multi-key operations —
those land with a later adapter, named, tested, and never smuggled into
`get` / `set`.

### No adapter package without a consumer

The Pegma rule: do not create an adapter package until implementation
begins and a named consumer exists. Phase 2 created `@pegma/cache-redis`
and Phase 3 creates `@pegma/cache-azure-redis` because RetireGolden.org
and Exsimplify are named future hosts. `cache-elasticache` and
`cache-upstash-redis` wait.

### Vendor clients stay behind the port

Application code depends on `CacheStore`. An adapter may import `ioredis`
or the Azure SDK; a host must not. The memory store exists so tests and
local composition never take a network client.

## Scope

### In scope

- Ports (`CacheResult`, `CacheCodec`, `CacheKey`, `CacheStore`).
- `formatCacheKey`, JSON/bytes codecs, single-flight helper.
- In-memory store for tests and local hosts.
- Conformance: namespace isolation, TTL vs injected Clock, single-flight,
  tag invalidation, fail-open compute on backend error.
- Optional XFetch on `getOrCompute`.

### Non-goals

- **Durability, transactions, or optimistic concurrency.**
  `@pegma/storage-core`.
- **Implicit cross-partition multi-key operations.** Hash tags are
  formatting, not a multi-key API.
- **Unbounded local memory fallbacks when a remote cache is down.**
  Fail-open computes; it does not accumulate.
- **Vendor clients in application code.**
- **ElastiCache / Upstash packages in Phase 3.**
  Those remain later phases.

## Package architecture

| Package                      | Responsibility                     | Phase |
| ---------------------------- | ---------------------------------- | ----- |
| `@pegma/cache-core`          | Port, codecs, helper, memory store | 1     |
| `@pegma/cache-conformance`   | Executable suite                   | 1     |
| `@pegma/cache-redis`         | Generic Redis adapter              | 2     |
| `@pegma/cache-azure-redis`   | Azure Cache for Redis adapter      | 3     |
| `@pegma/cache-elasticache`   | Amazon ElastiCache adapter         | 4     |
| `@pegma/cache-upstash-redis` | Upstash Redis adapter              | 5     |

Dependencies: `@pegma/spine` pinned exactly. Conformance pins
`@pegma/cache-core` to the workspace version.

## Delivery phases

### Phase 1 — port, memory store, conformance

`CacheStore`, codecs, `formatCacheKey`, single-flight `getOrCompute`
helper, in-memory store, and the suite cases listed above. The in-memory
store is the first adapter and must pass.

### Phase 2 — generic Redis adapter

`@pegma/cache-redis` against a real empty Redis (or a faithful local
server). Created because RetireGolden.org and Exsimplify are named future
hosts. Must pass `@pegma/cache-conformance`. Expiry stays on the injected
Clock; tag invalidation uses a sidecar index and never implies a
multi-key command.

### Phase 3 — Azure Cache for Redis (this PR)

Thin adapter over the same port. Azure Cache for Redis speaks Redis, so
`@pegma/cache-azure-redis` composes `@pegma/cache-redis` rather than
wrapping a data-plane Azure SDK. Real backend, same suite.

### Phase 4 — Amazon ElastiCache

Thin adapter. Cluster hash-tag behaviour is proven here, not implied.

### Phase 5 — Upstash Redis

Thin adapter for the serverless Redis client. Same suite.

## Open questions

**Distributed single-flight.** Process-local coalescing is Phase 1.
A Redis-backed lock or Redlock-shaped helper is a later adapter concern
and must not leak into the port as a durability claim.

**Tag invalidation on cluster.** Memory can scan. Cluster adapters may
need a sidecar index or hash-tagged tag keys. The suite asserts the
observable (tagged entries disappear); it does not prescribe the index.

**XFetch beta defaults.** Phase 1 leaves beta optional and off unless
requested. A default will be chosen when a second consumer shares a
preference — not before.
