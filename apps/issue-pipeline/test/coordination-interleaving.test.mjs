// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import "./isolated-root-test-kit.mjs";
import { coordination } from "../src/coordination.ts";
import { assertReconciled, confirmedWrite } from "../src/execution.ts";
import { world } from "./coordination-test-kit.mjs";

/** @import { CoordinationPort } from "../src/coordination.ts" */
const UNCERTAIN = /uncertain/u;
for (const lane of ["same", "different"]) {
  test(`atomic acquisition fences interleaved ${lane} lanes with incomplete initial listings`, () => {
    const github = world();
    const first = github.guard("A", "scope", "same");
    const aRequest = first.request();
    const second = github.guard("B", "scope", lane);
    second.request();
    const cfgB = { ...github.cfg, slug: `${github.cfg.slug}-machine-b` };
    /** @type {CoordinationPort} */
    const portB = {
      ...github.port,
      comments: () => {
        assertReconciled(cfgB, github.issue);
        return structuredClone(
          github.comments.filter((row) => row.id !== aRequest),
        );
      },
      write: (operation, write, confirmed) =>
        confirmedWrite(cfgB, github.issue, operation, { write, confirmed }),
    };
    const b = coordination(cfgB, portB, "scope", {
      instance: "B",
      lane,
      issue: github.issue,
      branch: `work/issue-${github.issue}`,
    });
    let bWon = false;
    /** @type {CoordinationPort} */
    const portA = {
      ...github.port,
      write: (operation, write, confirmed) => {
        if (operation === "acquire") {
          bWon = b.acquire();
        }
        github.port.write(operation, write, confirmed);
      },
    };
    const a = coordination(github.cfg, portA, "scope", {
      instance: "A",
      lane: "same",
      issue: github.issue,
      branch: `work/issue-${github.issue}`,
    });
    assert.throws(() => a.acquire(), UNCERTAIN);
    assert.equal(bWon, true);
    // The complete listing still confirms B; A's older request cannot use
    // comment order to override the single immutable acquisition result.
    portB.comments = () => structuredClone(github.comments);
    b.assertOwner();
    assert.equal(b.read().owner?.identity.instance, "B");
    assert.throws(() => a.assertOwner(), UNCERTAIN);
    assert.throws(() => a.save({ heartbeat: "late" }), UNCERTAIN);
    assert.equal(github.locks.size, 1);
  });
}
