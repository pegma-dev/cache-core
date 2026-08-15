import { describe, it } from "vitest";

import {
  createControllableClock,
  createMemoryCacheStore,
  createUnavailableCacheStore,
} from "@pegma/cache-core";
import { noopLogger } from "@pegma/spine";

import { conformanceCases } from "./index.js";

const START = "2026-08-15T16:00:00.000Z";

describe("createMemoryCacheStore", () => {
  for (const testCase of conformanceCases) {
    it(testCase.name, async () => {
      const clock = createControllableClock(START);
      const logger = noopLogger;
      await testCase.run({
        clock,
        logger,
        createStore: () => createMemoryCacheStore({ clock, logger }),
        createUnavailableStore: () =>
          createUnavailableCacheStore({ clock, logger }),
      });
    });
  }
});
