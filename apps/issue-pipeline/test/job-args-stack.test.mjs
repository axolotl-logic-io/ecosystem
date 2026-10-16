// @ts-check
// The stage job's --stack-on argument (#268): the issue whose branch a run's
// issue starts on when it has none of its own.
import assert from "node:assert/strict";
import { test } from "node:test";
import { jobArgsOf } from "../src/job/args.ts";

const RUN = ["--config", "c.json", "--issue", "7", "--stage", "implement"];
const PREREQ = 5;
const NOT_A_PREREQ = /--stack-on must be an issue number other than --issue/u;

test("--stack-on names the prerequisite of a --stage run", () => {
  const args = jobArgsOf([...RUN, "--stack-on", String(PREREQ)]);
  assert.equal(args.kind, "run");
  assert.equal("stackOn" in args && args.stackOn, PREREQ);
});

test("--stack-on must be a positive issue number", () => {
  assert.throws(() => jobArgsOf([...RUN, "--stack-on", "0"]), NOT_A_PREREQ);
  assert.throws(() => jobArgsOf([...RUN, "--stack-on", "x"]), NOT_A_PREREQ);
});

test("--stack-on can't name the run's own issue", () => {
  assert.throws(() => jobArgsOf([...RUN, "--stack-on", "7"]), NOT_A_PREREQ);
});
