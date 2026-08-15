# Contributing to Cache Core

Thank you for helping improve Cache Core.

## Before opening an issue

- Search existing issues for related work.
- Use GitHub's private vulnerability reporting flow for security concerns.
- Describe the cache behaviour you need and which refusal it must not
  violate (durability, cross-partition multi-key ops, unbounded memory
  fallback, vendor clients in application code).
- If a proposal needs this package to own durable state or to create an
  adapter before a consumer exists, say so explicitly — those are the
  changes the design cannot absorb.

## Local development

Cache Core requires Node.js 22 or 24.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm run check
pnpm test
pnpm run test:redis
pnpm run format:check
```

## Pull requests

Keep pull requests focused. Include:

- the problem being solved;
- the intended component behavior;
- conformance cases for any behaviour a host or adapter may rely on;
- documentation for public API changes.

A behaviour that is not in the conformance suite is not part of the contract.

## License

By contributing, you agree that your contributions will be licensed under the
MIT License.
