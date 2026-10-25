// The runtime harness must never resolve its new authority reads to real gh.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { repliesAt, stateAt } from "../job-fixtures.ts";
import { setUp } from "./job-test-kit.ts";

const UNSUPPORTED = /unsupported private fake gh request/u;
const GH_ENV: { [x: string]: string | undefined } = {
  ...process.env,
  ...Object.fromEntries([["GH_TOKEN", "fake-pipeline-merge--bot"]]),
};
const MARK = "<!-- agent-pipeline:state\n";

test("each job owns a default-deny fake gh with author and collaborator reads", () => {
  const place = setUp(repliesAt("author"), {});
  const gh = path.join(place.bin, "gh");
  const issue = spawnSync(gh, ["api", "repos/o/r/issues/7"], {
    encoding: "utf8",
    env: GH_ENV,
  });
  assert.equal(issue.status, 0, issue.stderr);
  assert.equal(JSON.parse(issue.stdout).user.login, "alice");
  const collaborator = spawnSync(gh, ["api", "repos/o/r/collaborators/alice"], {
    encoding: "utf8",
    env: GH_ENV,
  });
  assert.equal(collaborator.status, 0, collaborator.stderr);
  const unsupported = spawnSync(gh, ["pr", "merge", "42"], {
    encoding: "utf8",
    env: GH_ENV,
  });
  assert.equal(unsupported.status, 1);
  assert.match(unsupported.stderr, UNSUPPORTED);
});

test("successful fake save ops expose the exact complete saved receipt to subsequent gh reads", () => {
  const place = setUp(repliesAt("implement"), {});
  const state = stateAt("merge", {
    branch: "agent/issue-7",
    codeMerged: { pr: 42, sha: "fixture-merge" },
  });
  const request = { op: "save-state", config: place.config, number: 7, state };
  const save = spawnSync(process.execPath, [path.join(place.root, "ops.mjs")], {
    input: `BEGIN_OPS_REQUEST\n${JSON.stringify(request)}\nEND_OPS_REQUEST`,
    encoding: "utf8",
    env: GH_ENV,
  });
  assert.equal(save.status, 0, save.stderr);
  const comments = spawnSync(
    path.join(place.bin, "gh"),
    ["api", "repos/o/r/issues/7/comments?per_page=100"],
    { encoding: "utf8", env: GH_ENV },
  );
  assert.equal(comments.status, 0, comments.stderr);
  const comment = JSON.parse(comments.stdout);
  assert.equal(comment.user.login, "bot");
  const start = comment.body.indexOf(MARK) + MARK.length;
  const saved = JSON.parse(
    comment.body.slice(start, comment.body.indexOf("-->", start)),
  );
  assert.deepEqual(saved, state);
});
