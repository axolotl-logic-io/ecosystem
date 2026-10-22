import assert from "node:assert/strict";
import { test } from "node:test";
import { capacity } from "../legacy-capacity.ts";
import { makeRun } from "./model-fixtures.ts";

test("legacy capacity distinguishes slot groups, ignores dead runs and reports pb-web scope", () => {
  assert.deepEqual(
    capacity([
      makeRun({ stage: "author" }),
      makeRun({ stage: "review", scope: "pb-web" }),
      makeRun({ stage: "review" }),
      makeRun({ stage: "implement" }, { live: false }),
    ]),
    {
      activeRuns: 3,
      limit: 4,
      authorImplementation: 1,
      hardening: 2,
      authorImplementationLimit: 2,
      hardeningLimit: 2,
      pbWeb: [1],
    },
  );
});
