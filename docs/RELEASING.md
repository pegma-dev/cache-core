# Release operations

`@pegma/cache-core`, `@pegma/cache-conformance`, `@pegma/cache-redis`,
`@pegma/cache-azure-redis`, `@pegma/cache-elasticache`, and
`@pegma/cache-upstash-redis` publish only from a stable GitHub release.
Merging a pull request never publishes, and the workflow has no
manual-dispatch or npm-token fallback.

## Required external configuration

Before the first release through this workflow:

- configure `@pegma/cache-core`, `@pegma/cache-conformance`,
  `@pegma/cache-redis`, `@pegma/cache-azure-redis`,
  `@pegma/cache-elasticache`, and `@pegma/cache-upstash-redis` on npm
  with the GitHub Actions trusted publisher `pegma-dev/cache-core`,
  workflow `publish.yml`, environment `npm-publish`, and allowed action
  `npm publish`;
- create the GitHub `npm-publish` environment. A second reviewer is not
  required under Pegma's single-maintainer policy;
- create the repository Actions variable `RELEASE_ALLOWED_SIGNERS` containing
  the reviewed Git SSH allowed-signers entry for the maintainer's release key;
  this is public-key material, not a secret; and
- create an active tag ruleset targeting `v*` that prevents tag updates and
  deletions and limits tag creation to the release maintainer.

Do not add `NODE_AUTH_TOKEN`, an npm automation token, or another credential
fallback. After one trusted-publisher release is verified, disable any
remaining traditional npm publish tokens.

## Release procedure

The version in `packages/cache-core/package.json`,
`packages/cache-conformance/package.json`,
`packages/cache-redis/package.json`,
`packages/cache-azure-redis/package.json`,
`packages/cache-elasticache/package.json`, and
`packages/cache-upstash-redis/package.json` is the release version. All
public packages publish at the same version. Change it through an ordinary
reviewed pull request and run the complete gate on Node 22 and 24,
including `pnpm run test:redis`, `pnpm run test:azure-redis`,
`pnpm run test:elasticache`, and `pnpm run test:upstash-redis`.

After that pull request is merged, create a signed annotated tag at the exact
`origin/main` commit, push the tag, verify the fetched tag, and only then
create the GitHub release with `--verify-tag`. Do not let GitHub create the tag
and never move or recreate a release tag.

Before checkout, workflow-owned code verifies that the tag:

- is a stable annotated `vX.Y.Z` tag signed by an allowed signer;
- points to the checkout and the GitHub release-event commit; and
- is contained in `origin/main`.

After checkout, preparation also verifies that the tag matches a public
package version. Before publication, workflow-owned code repeats the tag
checks and verifies the package version from the sealed manifest.

Its preparation job has no OIDC permission. It installs the reviewed npm
`11.18.0` release and the pinned pnpm without dependency caching, runs the
full gate, builds and packs once with that npm CLI, revalidates each packed
manifest, records SHA-1, SHA-256, and SHA-512 integrity, seals the exact
release-directory inventory, and uploads only those prepared artifacts. The
lockfile source of truth is `pnpm-lock.yaml`.

A separate unprivileged job downloads the sealed artifact and installs and
imports every tarball from a clean consumer directory. Only the
`npm-publish` job receives `id-token: write`. It checks out no repository
code, installs no project dependencies, and does not download pnpm. Its
workflow-owned verifier re-authenticates the tag, verifies the prepared
manifest digest, exact inventory, and tarball hashes against the release
commit, then publishes from an empty temporary directory with isolated npm
configuration and npm provenance.

## Safe retry

The workflow is globally serialized. Re-run the failed release jobs against
the unchanged tag:

- an absent version is published;
- an existing version with identical `dist.integrity` is verified and skipped;
- a different integrity, or any registry error other than `E404`, stops the
  release.

Never unpublish and reuse a version. If any released byte must change, prepare
a new version and a new signed tag.
