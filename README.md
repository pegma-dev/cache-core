# Cache Core

[![CI](https://github.com/pegma-dev/cache-core/actions/workflows/ci.yml/badge.svg)](https://github.com/pegma-dev/cache-core/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Provider-neutral ephemeral caching for [Pegma](https://pegma.dev) hosts:
typed key namespaces, cache-aside `getOrCompute` with stampede protection,
and a conformance suite every adapter must pass.

> [!IMPORTANT]
> Pegma is in early `0.x` development. Packages are not published yet. No
> public API is stable.

## Owns

- Strict key namespacing with schema-aware codecs (JSON and binary)
- Cache-aside `getOrCompute` with single-flight coalescing and optional
  probabilistic early expiration (XFetch)
- Sliding and absolute TTL via an injected Spine `Clock`
- Fail-open / fail-closed fallback policies
- A conformance suite every adapter must pass

## Refuses

- Durability guarantees — durable state belongs in
  [`@pegma/storage-core`](https://github.com/pegma-dev/storage-core)
- Implicit cross-partition multi-key ops; Redis Cluster hash tags are in
  the contract
- Unbounded local memory fallbacks when a remote cache is down
- Vendor clients leaking into application code

## Packages

| Package                      | Role                                      | Phase |
| ---------------------------- | ----------------------------------------- | ----- |
| `@pegma/cache-core`          | Port, codecs, single-flight, memory store | 1     |
| `@pegma/cache-conformance`   | Executable suite every adapter must pass  | 1     |
| `@pegma/cache-redis`         | Generic Redis adapter                     | later |
| `@pegma/cache-azure-redis`   | Azure Cache for Redis adapter             | later |
| `@pegma/cache-elasticache`   | Amazon ElastiCache adapter                | later |
| `@pegma/cache-upstash-redis` | Upstash Redis adapter                     | later |

Adapter packages are not created until implementation begins and a named
consumer exists.

## Constraint that shapes everything

**The conformance suite is the specification.** A behaviour not asserted
there is not something a host may rely on. An adapter is finished when it
passes the suite.

## Documentation

- [Project plan](docs/PROJECT_PLAN.md) — phases, scope, and decisions
- [Releasing](docs/RELEASING.md) — trusted-publisher release runbook

## Development

Requires Node.js 22 or 24. Corepack is bundled through Node 24; on Node 25
or newer, install it first.

```sh
npm install -g corepack
corepack enable
pnpm install --frozen-lockfile
pnpm run format:check
pnpm run check
pnpm test
```

## License

[MIT](LICENSE) © 2026 RetireGolden, LLC
