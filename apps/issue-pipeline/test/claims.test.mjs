// liveClaims from ops.mjs: which comments count as a lane's claim on an issue.
import assert from "node:assert/strict";
import { test } from "node:test";
import { liveClaims } from "../src/claims.ts";

const cfg = { account: "bot", leaseHours: 3 };
const now = new Date().toISOString();
const claimBody = (lane) =>
  `**🤖 issue-pipeline · claim**\n<!-- agent-pipeline:comment role=claim -->\n\nLane \`${lane}\` is claiming this issue.\n<!-- agent-pipeline:claim lane=${lane} sweep=s1 -->`;
const comment = (id, body, login = "bot", at = now) => ({
  id,
  body,
  user: { login },
  created_at: at,
  updated_at: at,
});

test("a claim the pipeline posted counts", () => {
  assert.deepEqual(
    liveClaims(cfg, [
      comment(2, claimBody("b")),
      comment(1, claimBody("a")),
    ]).map((c) => c.lane),
    ["a", "b"],
  );
});

test("a person quoting the claim marker from the same account doesn't count (#120)", () => {
  const quoted =
    "The claim format is `<!-- agent-pipeline:claim lane=<lane> sweep=<sweep> -->`.";
  assert.deepEqual(
    liveClaims(cfg, [comment(1, quoted), comment(2, claimBody("b"))]).map(
      (c) => c.lane,
    ),
    ["b"],
  );
});

test("a pipeline comment of another role carrying the claim marker doesn't count", () => {
  const body = claimBody("a").replace("role=claim", "role=coordinator");
  assert.deepEqual(liveClaims(cfg, [comment(1, body)]), []);
});

test("a claim from another account doesn't count", () => {
  assert.deepEqual(
    liveClaims(cfg, [comment(1, claimBody("a"), "visitor")]),
    [],
  );
});

test("a claim not edited for leaseHours has expired", () => {
  const old = new Date(Date.now() - 4 * 3600 * 1000).toISOString();
  assert.deepEqual(
    liveClaims(cfg, [comment(1, claimBody("a"), "bot", old)]),
    [],
  );
});

test("a closed claim doesn't count", () => {
  const closed = claimBody("a").replace(
    "agent-pipeline:claim lane",
    "agent-pipeline:claim-closed lane",
  );
  assert.deepEqual(liveClaims(cfg, [comment(1, closed)]), []);
});
