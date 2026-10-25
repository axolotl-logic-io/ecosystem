// The real direct job refuses unauthorized issue authors before any model,
// metadata clone, claim or lease write, using only local origins and fakes.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { z } from "zod";
import "./isolated-root-test-kit.ts";
import { ghCalls } from "./fake-pipeline-flow-gh.ts";
import { readWorld, writeWorld } from "./fake-pipeline-flow-gh-world.ts";
import { piLog } from "./fake-pipeline-flow-pi.ts";
import { runStage } from "./pipeline-flow-run-test-kit.ts";
import {
  authorTurn,
  openFlowIssue,
  savedState,
} from "./pipeline-flow-script-test-kit.ts";
import { ISSUE, scriptPi, setUpFlow } from "./pipeline-flow-test-kit.ts";

const { ghIsRead }: typeof import("../src/github.ts") = await import(
  "../src/github.ts"
);
const ALLOWED = "alice";
const VISITOR = "visitor";
const GHERKIN =
  "Feature: greeting\n  Scenario: hello\n    Given a visitor\n    Then they see hello";
const CONFIG = z.looseObject({ allowedUsers: z.array(z.string()) });
const AUTHORIZATION_REFUSAL =
  /job exited 1: job: issue author @.+ is not on allowedUsers or not a collaborator/u;

for (const login of [VISITOR, ALLOWED]) {
  test(`direct Author job refuses ${login} lacking one authorization predicate without a model or writes`, () => {
    const flow = setUpFlow();
    openFlowIssue(flow, login, "Assigned task", "Untrusted requirements");
    const world = readWorld(flow.ghDir);
    // The visitor IS a collaborator; Alice IS allowlisted but not a collaborator.
    world.collaborators = [VISITOR];
    writeWorld(flow.ghDir, world);
    assert.throws(() => runStage(flow, "author"), AUTHORIZATION_REFUSAL);
    assert.deepEqual(piLog(flow.piDir), []);
    assert.deepEqual(
      ghCalls(flow.ghDir).filter((args) => !ghIsRead(args)),
      [],
    );
    assert.deepEqual(readWorld(flow.ghDir).comments, []);
    assert.deepEqual(readWorld(flow.ghDir).issues, world.issues);
    assert.deepEqual(readWorld(flow.ghDir).unsupported, []);
    for (const entry of ["clones", "mirrors", "work", "runs"]) {
      assert.equal(fs.existsSync(path.join(flow.root, entry)), false);
    }
  });
}

for (const revoked of ["allow-list", "collaborator"]) {
  test(`revoking the ${revoked} predicate between stage jobs prevents the next model, claim and lease`, () => {
    const flow = setUpFlow();
    openFlowIssue(flow, ALLOWED, "Assigned task", "Trusted requirements");
    scriptPi(flow, { author: [authorTurn(GHERKIN, true)] });
    assert.equal(runStage(flow, "author").end, "next");
    const world = readWorld(flow.ghDir);
    const issue = world.issues.find(({ number }) => number === ISSUE);
    assert.ok(issue);
    issue.body = "Revoked author's new requirements";
    if (revoked === "collaborator") {
      world.collaborators = [];
    } else {
      const config = CONFIG.parse(
        JSON.parse(fs.readFileSync(flow.config, "utf8")),
      );
      config.allowedUsers = ["someone-else"];
      fs.writeFileSync(flow.config, JSON.stringify(config));
    }
    writeWorld(flow.ghDir, world);
    const launches = piLog(flow.piDir);
    assert.ok(launches.length > 0);
    const calls = ghCalls(flow.ghDir).length;
    const state = savedState(world);

    assert.throws(() => runStage(flow, "implement"), AUTHORIZATION_REFUSAL);
    assert.deepEqual(piLog(flow.piDir), launches);
    assert.deepEqual(
      ghCalls(flow.ghDir)
        .slice(calls)
        .filter((args) => !ghIsRead(args)),
      [],
    );
    const after = readWorld(flow.ghDir);
    assert.deepEqual(after.comments, world.comments);
    assert.deepEqual(after.issues, world.issues);
    assert.deepEqual(savedState(after), state);
    assert.deepEqual(after.unsupported, []);
  });
}
