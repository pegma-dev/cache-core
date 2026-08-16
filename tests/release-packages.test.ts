import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  RELEASE_PACKAGES,
  decidePublication,
  isNormalReleaseVersion,
  lockDependencyMatches,
  parseArguments,
  parseNpmJson,
  parsePnpmLockfileImporters,
  resolvedVersionSatisfies,
  validateRepository,
} from "../scripts/release-packages.mjs";

const packageVersion = (
  JSON.parse(
    readFileSync(
      join(process.cwd(), "packages", "cache-core", "package.json"),
      "utf8",
    ),
  ) as { version: string }
).version;

describe("release package metadata", () => {
  it("accepts npm's cross-platform argument separator", () => {
    expect(parseArguments(["--", "--output", ".release"])).toEqual({
      output: ".release",
    });
  });

  it("validates package manifests and the lockfile together", async () => {
    await expect(validateRepository()).resolves.toBeDefined();
  });

  it("keeps the exact public package inventory in dependency order", () => {
    expect(RELEASE_PACKAGES.map(({ name }) => name)).toEqual([
      "@pegma/cache-core",
      "@pegma/cache-conformance",
      "@pegma/cache-redis",
      "@pegma/cache-azure-redis",
      "@pegma/cache-elasticache",
      "@pegma/cache-upstash-redis",
    ]);
  });

  it("ships the synchronized 0.1.1 package set with exact internal pins", () => {
    const manifests = RELEASE_PACKAGES.map(({ directory }) =>
      JSON.parse(
        readFileSync(
          join(process.cwd(), "packages", directory, "package.json"),
          "utf8",
        ),
      ),
    ) as Array<{
      name: string;
      version: string;
      dependencies?: Record<string, string>;
      scripts?: { prepack?: string };
    }>;

    expect(manifests.map(({ name, version }) => ({ name, version }))).toEqual([
      { name: "@pegma/cache-core", version: "0.1.1" },
      { name: "@pegma/cache-conformance", version: "0.1.1" },
      { name: "@pegma/cache-redis", version: "0.1.1" },
      { name: "@pegma/cache-azure-redis", version: "0.1.1" },
      { name: "@pegma/cache-elasticache", version: "0.1.1" },
      { name: "@pegma/cache-upstash-redis", version: "0.1.1" },
    ]);
    expect(manifests[1]?.dependencies?.["@pegma/cache-core"]).toBe("0.1.1");
    expect(manifests[2]?.dependencies?.["@pegma/cache-core"]).toBe("0.1.1");
    expect(manifests[3]?.dependencies?.["@pegma/cache-core"]).toBe("0.1.1");
    expect(manifests[3]?.dependencies?.["@pegma/cache-redis"]).toBe("0.1.1");
    expect(manifests[4]?.dependencies?.["@pegma/cache-core"]).toBe("0.1.1");
    expect(manifests[4]?.dependencies?.["@pegma/cache-redis"]).toBe("0.1.1");
    expect(manifests[5]?.dependencies?.["@pegma/cache-core"]).toBe("0.1.1");
    expect(manifests[5]?.dependencies?.["@pegma/cache-redis"]).toBe("0.1.1");
    expect(manifests[0]?.dependencies?.["@pegma/spine"]).toBe("0.1.2");
    expect(manifests[2]?.dependencies?.["@pegma/spine"]).toBe("0.1.2");
    expect(manifests[3]?.dependencies?.["@pegma/spine"]).toBe("0.1.2");
    expect(manifests[4]?.dependencies?.["@pegma/spine"]).toBe("0.1.2");
    expect(manifests[5]?.dependencies?.["@pegma/spine"]).toBe("0.1.2");
    expect(packageVersion).toBe("0.1.1");
    for (const manifest of manifests) {
      expect(manifest.scripts?.prepack).toBe("tsc -p tsconfig.json");
    }
  });

  it("rejects the bootstrap range from the normal release lane", () => {
    expect(isNormalReleaseVersion("0.0.0")).toBe(false);
    expect(isNormalReleaseVersion("0.0.1")).toBe(false);
    expect(isNormalReleaseVersion("0.1.0")).toBe(true);
    expect(isNormalReleaseVersion("1.0.0")).toBe(true);
  });

  it("pins pnpm as the workspace package manager", () => {
    const manifest = JSON.parse(
      readFileSync(join(process.cwd(), "package.json"), "utf8"),
    ) as { packageManager?: string };
    expect(manifest.packageManager).toBe("pnpm@10.34.5");
    expect(existsSync(join(process.cwd(), "pnpm-lock.yaml"))).toBe(true);
    expect(existsSync(join(process.cwd(), "pnpm-workspace.yaml"))).toBe(true);
    expect(existsSync(join(process.cwd(), "package-lock.json"))).toBe(false);
    expect(existsSync(join(process.cwd(), "yarn.lock"))).toBe(false);
  });

  it("reads workspace inventory and link pins from pnpm-lock.yaml", () => {
    const importers = parsePnpmLockfileImporters(`importers:

  .:
    devDependencies:
      prettier:
        specifier: ^3.9.6
        version: 3.9.6

  packages/cache-core:
    dependencies:
      '@pegma/spine':
        specifier: 0.1.2
        version: 0.1.2

  packages/cache-conformance:
    dependencies:
      '@pegma/cache-core':
        specifier: 0.1.0
        version: link:../cache-core
      '@pegma/spine':
        specifier: 0.1.2
        version: 0.1.2

  packages/cache-redis:
    dependencies:
      '@pegma/cache-core':
        specifier: 0.1.0
        version: link:../cache-core
      '@pegma/spine':
        specifier: 0.1.2
        version: 0.1.2
      ioredis:
        specifier: ^5.8.2
        version: 5.8.2
    devDependencies:
      '@pegma/cache-conformance':
        specifier: 0.1.0
        version: link:../cache-conformance

  packages/cache-azure-redis:
    dependencies:
      '@pegma/cache-core':
        specifier: 0.1.0
        version: link:../cache-core
      '@pegma/cache-redis':
        specifier: 0.1.0
        version: link:../cache-redis
      '@pegma/spine':
        specifier: 0.1.2
        version: 0.1.2
    devDependencies:
      '@pegma/cache-conformance':
        specifier: 0.1.0
        version: link:../cache-conformance
      ioredis:
        specifier: ^5.8.2
        version: 5.8.2

  packages/cache-elasticache:
    dependencies:
      '@pegma/cache-core':
        specifier: 0.1.0
        version: link:../cache-core
      '@pegma/cache-redis':
        specifier: 0.1.0
        version: link:../cache-redis
      '@pegma/spine':
        specifier: 0.1.2
        version: 0.1.2
    devDependencies:
      '@pegma/cache-conformance':
        specifier: 0.1.0
        version: link:../cache-conformance
      ioredis:
        specifier: ^5.8.2
        version: 5.8.2

  packages/cache-upstash-redis:
    dependencies:
      '@pegma/cache-core':
        specifier: 0.1.0
        version: link:../cache-core
      '@pegma/cache-redis':
        specifier: 0.1.0
        version: link:../cache-redis
      '@pegma/spine':
        specifier: 0.1.2
        version: 0.1.2
      '@upstash/redis':
        specifier: ^1.38.2
        version: 1.38.2
    devDependencies:
      '@pegma/cache-conformance':
        specifier: 0.1.0
        version: link:../cache-conformance
      ioredis:
        specifier: ^5.8.2
        version: 5.8.2

packages:
  prettier@3.9.6:
    resolution: {integrity: sha512-example}
`);
    expect(Object.keys(importers)).toEqual([
      ".",
      "packages/cache-core",
      "packages/cache-conformance",
      "packages/cache-redis",
      "packages/cache-azure-redis",
      "packages/cache-elasticache",
      "packages/cache-upstash-redis",
    ]);
    expect(importers["packages/cache-core"]).toEqual({
      dependencies: {
        "@pegma/spine": { specifier: "0.1.2", version: "0.1.2" },
      },
    });
    expect(
      importers["packages/cache-conformance"]?.dependencies?.[
        "@pegma/cache-core"
      ],
    ).toEqual({
      specifier: "0.1.0",
      version: "link:../cache-core",
    });
    expect(importers["packages/cache-conformance"]?.peerDependencies).toBe(
      undefined,
    );

    const live = parsePnpmLockfileImporters(
      readFileSync(join(process.cwd(), "pnpm-lock.yaml"), "utf8"),
    );
    expect(
      live["packages/cache-conformance"]?.dependencies?.["@pegma/cache-core"],
    ).toEqual({
      specifier: "0.1.1",
      version: "link:../cache-core",
    });
    expect(
      lockDependencyMatches(
        live["packages/cache-core"]?.dependencies?.["@pegma/spine"],
        "0.1.2",
      ),
    ).toBe(true);
    expect(
      lockDependencyMatches(
        live["packages/cache-conformance"]?.dependencies?.["@pegma/cache-core"],
        "0.1.1",
        { workspace: true },
      ),
    ).toBe(true);
    expect(
      live["packages/cache-redis"]?.dependencies?.["@pegma/cache-core"],
    ).toEqual({
      specifier: "0.1.1",
      version: "link:../cache-core",
    });
    expect(
      lockDependencyMatches(
        live["packages/cache-redis"]?.dependencies?.["@pegma/spine"],
        "0.1.2",
      ),
    ).toBe(true);
    expect(
      lockDependencyMatches(
        live["packages/cache-redis"]?.devDependencies?.[
          "@pegma/cache-conformance"
        ],
        "0.1.1",
        { workspace: true },
      ),
    ).toBe(true);
    expect(
      lockDependencyMatches(
        live["packages/cache-redis"]?.dependencies?.ioredis,
        "^5.8.2",
      ),
    ).toBe(true);
    expect(
      live["packages/cache-azure-redis"]?.dependencies?.["@pegma/cache-redis"],
    ).toEqual({
      specifier: "0.1.1",
      version: "link:../cache-redis",
    });
    expect(
      lockDependencyMatches(
        live["packages/cache-azure-redis"]?.dependencies?.["@pegma/spine"],
        "0.1.2",
      ),
    ).toBe(true);
    expect(
      lockDependencyMatches(
        live["packages/cache-azure-redis"]?.devDependencies?.[
          "@pegma/cache-conformance"
        ],
        "0.1.1",
        { workspace: true },
      ),
    ).toBe(true);
    expect(
      lockDependencyMatches(
        live["packages/cache-azure-redis"]?.devDependencies?.ioredis,
        "^5.8.2",
      ),
    ).toBe(true);
    expect(
      live["packages/cache-elasticache"]?.dependencies?.["@pegma/cache-redis"],
    ).toEqual({
      specifier: "0.1.1",
      version: "link:../cache-redis",
    });
    expect(
      lockDependencyMatches(
        live["packages/cache-elasticache"]?.dependencies?.["@pegma/spine"],
        "0.1.2",
      ),
    ).toBe(true);
    expect(
      lockDependencyMatches(
        live["packages/cache-elasticache"]?.devDependencies?.[
          "@pegma/cache-conformance"
        ],
        "0.1.1",
        { workspace: true },
      ),
    ).toBe(true);
    expect(
      lockDependencyMatches(
        live["packages/cache-elasticache"]?.devDependencies?.ioredis,
        "^5.8.2",
      ),
    ).toBe(true);
    expect(
      live["packages/cache-upstash-redis"]?.dependencies?.[
        "@pegma/cache-redis"
      ],
    ).toEqual({
      specifier: "0.1.1",
      version: "link:../cache-redis",
    });
    expect(
      lockDependencyMatches(
        live["packages/cache-upstash-redis"]?.dependencies?.["@pegma/spine"],
        "0.1.2",
      ),
    ).toBe(true);
    expect(
      lockDependencyMatches(
        live["packages/cache-upstash-redis"]?.devDependencies?.[
          "@pegma/cache-conformance"
        ],
        "0.1.1",
        { workspace: true },
      ),
    ).toBe(true);
    expect(
      lockDependencyMatches(
        live["packages/cache-upstash-redis"]?.dependencies?.["@upstash/redis"],
        "^1.38.2",
      ),
    ).toBe(true);
    expect(
      lockDependencyMatches(
        live["packages/cache-upstash-redis"]?.devDependencies?.ioredis,
        "^5.8.2",
      ),
    ).toBe(true);
  });

  it("matches each lockfile dependency to its own specifier and resolved version", () => {
    expect(
      lockDependencyMatches({ specifier: "0.1.2", version: "0.1.2" }, "0.1.2"),
    ).toBe(true);
    expect(
      lockDependencyMatches({ specifier: "0.1.2", version: "0.4.0" }, "0.1.2"),
    ).toBe(false);
    expect(
      lockDependencyMatches(
        { specifier: "0.1.0", version: "link:../cache-core" },
        "0.1.0",
        { workspace: true },
      ),
    ).toBe(true);
    expect(
      lockDependencyMatches({ specifier: "0.1.0", version: "0.1.0" }, "0.1.0", {
        workspace: true,
      }),
    ).toBe(false);
    expect(resolvedVersionSatisfies("1.2.3", "^1.2.0")).toBe(true);
    expect(
      resolvedVersionSatisfies("1.2.3(@types/node@26.1.2)", "^1.2.0"),
    ).toBe(true);
    expect(resolvedVersionSatisfies("2.0.0", "^1.2.0")).toBe(false);
    expect(resolvedVersionSatisfies("0.2.9", "^0.2.3")).toBe(true);
    expect(resolvedVersionSatisfies("0.3.0", "^0.2.3")).toBe(false);
    expect(resolvedVersionSatisfies("0.0.3", "^0.0.3")).toBe(true);
    expect(resolvedVersionSatisfies("0.0.4", "^0.0.3")).toBe(false);
    expect(resolvedVersionSatisfies("0.1.1", "0.1.1")).toBe(true);
    expect(resolvedVersionSatisfies("0.1.1(@pegma/spine@0.1.1)", "0.1.1")).toBe(
      true,
    );
    expect(resolvedVersionSatisfies("0.1.2", "0.1.1")).toBe(false);
    expect(resolvedVersionSatisfies("1.2.3-rc.1", "1.2.3")).toBe(false);
    expect(resolvedVersionSatisfies("1.2.3-rc.1", "1.2.3-rc.1")).toBe(true);
    expect(
      resolvedVersionSatisfies("1.2.3-rc.1(@foo@1.0.0)", "1.2.3-rc.1"),
    ).toBe(true);
    expect(resolvedVersionSatisfies("1.2.3", "1.2.3-rc.1")).toBe(false);
    expect(resolvedVersionSatisfies("0.9.0", "^0")).toBe(true);
    expect(resolvedVersionSatisfies("1.0.0", "^0")).toBe(false);
    expect(resolvedVersionSatisfies("0.0.9", "^0.0")).toBe(true);
    expect(resolvedVersionSatisfies("0.1.0", "^0.0")).toBe(false);
  });

  it("keeps pack, registry view, and publish on the npm CLI", () => {
    const source = readFileSync(
      join(process.cwd(), "scripts/release-packages.mjs"),
      "utf8",
    );
    expect(source).not.toMatch(
      /(?:npmExecPath|npm_execpath)\s*(?:\?\?|===|!==)/u,
    );
    expect(source).toMatch(
      /function runNpm\([\s\S]*?process\.platform === "win32" \? "npm\.cmd" : "npm"/u,
    );
    expect(source).toMatch(/runNpm\(\["run", "build"\]/u);
    expect(source).not.toMatch(/runPnpm\(\["run", "build"\]/u);
    expect(source).toMatch(
      /const \[packed\] = parseNpmJson\(result\.stdout\)/u,
    );
    expect(source).not.toMatch(/JSON\.parse\(result\.stdout\)/u);
  });

  it("does not JSON.parse pnpm's human script banner", () => {
    const packed = [
      {
        name: "@pegma/cache-core",
        version: "0.1.1",
        filename: "pegma-cache-core-0.1.1.tgz",
        files: [],
      },
    ];
    const stdout = [
      "> @pegma/cache-core@0.1.0 build /home/runner/work/cache-core/cache-core/packages/cache-core",
      "> tsc -p tsconfig.json",
      "",
      JSON.stringify(packed),
    ].join("\n");
    expect(() => JSON.parse(stdout)).toThrow(SyntaxError);
    expect(parseNpmJson(stdout)).toEqual(packed);
    expect(parseNpmJson(`${JSON.stringify(packed)}\n`)).toEqual(packed);
    expect(parseNpmJson('"sha512-cHJlcGFyZWQtdGFyYmFsbA=="\n')).toBe(
      "sha512-cHJlcGFyZWQtdGFyYmFsbA==",
    );
  });
});

describe("release source authentication", () => {
  it("keeps preparation outside the OIDC-enabled publisher job", () => {
    const workflow = readFileSync(
      join(process.cwd(), ".github", "workflows", "publish.yml"),
      "utf8",
    );
    const jobsMarker = "\njobs:\n";
    const jobsIndex = workflow.indexOf(jobsMarker);
    expect(jobsIndex).toBeGreaterThanOrEqual(0);
    const header = workflow.slice(0, jobsIndex);
    const jobs = workflow.slice(jobsIndex + jobsMarker.length);
    const prepareStart = jobs.indexOf("  prepare:");
    const publishStart = jobs.indexOf("\n  publish:");
    expect(header).not.toContain("id-token: write");
    expect(prepareStart).toBeGreaterThanOrEqual(0);
    expect(publishStart).toBeGreaterThan(prepareStart);
    const prepare = jobs.slice(prepareStart, publishStart);
    const publish = jobs.slice(publishStart);
    expect(prepare).not.toContain("id-token: write");
    expect(prepare).toContain("npm install --global npm@11.18.0");
    expect(prepare).toContain("pnpm run release:pack");
    expect(prepare).toContain("pnpm run test:redis");
    expect(prepare).toContain("pnpm run test:azure-redis");
    expect(prepare).toContain("pnpm run test:elasticache");
    expect(prepare).toContain("pnpm run test:upstash-redis");
    expect(prepare).toContain("16379:6379");
    expect(publish).toContain("id-token: write");
    expect(publish).not.toContain("npm ci");
    expect(publish).toContain("npm install --global npm@11.18.0");
    expect(publish).not.toContain("pnpm install");
    expect(publish).not.toContain("corepack");
    expect(publish).not.toContain("pnpm run");
    expect(publish).not.toContain("pnpm/action-setup");
    expect(publish).toContain("node scripts/release-packages.mjs publish");
    expect(workflow).not.toContain("workflow_dispatch");
    expect(workflow).toContain("retention-days: 30");
  });
});

describe("retry-safe publication", () => {
  const integrity = "sha512-cHJlcGFyZWQtdGFyYmFsbA==";

  it("publishes an absent version", () => {
    expect(decidePublication(integrity, null)).toBe("publish");
  });

  it("skips a byte-identical existing version", () => {
    expect(decidePublication(integrity, integrity)).toBe("skip");
  });

  it("rejects an existing version with different bytes", () => {
    expect(() => decidePublication(integrity, "sha512-ZGlmZmVyZW50")).toThrow(
      "different tarball integrity",
    );
  });
});
