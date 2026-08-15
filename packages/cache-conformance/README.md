# `@pegma/cache-conformance`

Executable conformance suite every `@pegma/cache-core` adapter must pass.

> [!IMPORTANT]
> Pegma is in early `0.x` development. This package's public API is unstable.

```ts
import {
  createControllableClock,
  createMemoryCacheStore,
  createUnavailableCacheStore,
} from "@pegma/cache-core";
import { conformanceCases } from "@pegma/cache-conformance";
import { noopLogger } from "@pegma/spine";

const clock = createControllableClock("2026-08-15T16:00:00.000Z");
const logger = noopLogger;

for (const testCase of conformanceCases) {
  it(testCase.name, () =>
    testCase.run({
      clock,
      logger,
      createStore: () => createMemoryCacheStore({ clock, logger }),
      createUnavailableStore: () =>
        createUnavailableCacheStore({ clock, logger }),
    }),
  );
}
```

The suite is the specification. A behaviour that is not asserted here is
not something a host may rely on.
