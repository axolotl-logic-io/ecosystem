// @ts-check
// Historical REST branch dispatch preserves real two-parent graph/ref/PR evidence.
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { api } from "./fake-pipeline-flow-gh-api.mjs";
import { branchHead, gitIn } from "./fake-pipeline-flow-gh-world.mjs";
import { sh, world } from "./ops/ops-publish-test-kit.mjs";

const PR = 50;
const NEXT_ID = 1000;
const UNSUPPORTED = /fake-gh: unsupported/u;
const HTTP_CREATED = /^HTTP\/2\.0 201 Created\r\n\r\n/u;
const HTTP_UNCHANGED = /^HTTP\/2\.0 204 No Content\r\n\r\n$/u;
const HTTP_CONFLICT = /^HTTP\/2\.0 409 Conflict/u;

/** @returns {{ fixture: import("./fake-pipeline-flow-gh-world.mjs").World, head: string, parent: string }} */
function mergeWorld() {
  const w = world();
  const origin = path.join(w.root, "origin.git");
  const parent = gitIn(origin, ["rev-parse", "integration"]);
  gitIn(origin, ["update-ref", "refs/heads/main", parent]);
  return {
    head: w.sha,
    parent,
    fixture: {
      repo: "o/r",
      account: "bot",
      collaborators: [],
      origin,
      baseBranch: "integration",
      nativePushStart: 0,
      nativePushesSeen: 0,
      nextId: NEXT_ID,
      comments: [],
      repoLabels: [],
      unsupported: [],
      issues: [
        {
          number: PR,
          title: "Feature",
          body: "",
          login: "bot",
          state: "open",
          stateReason: null,
          labels: [],
          createdAt: "2026-01-01T00:00:00Z",
          isPull: true,
        },
      ],
      prs: [
        {
          number: PR,
          head: "agent/issue-7",
          base: "integration",
          title: "Feature",
          body: "",
          state: "OPEN",
          isDraft: false,
          mergeOid: null,
          mergedHead: null,
        },
      ],
    },
  };
}

/** @param {string} head @returns {string[]} */
function request(head) {
  return [
    "repos/o/r/merges",
    "--method",
    "POST",
    "--include",
    "-f",
    "base=integration",
    "-f",
    `head=${head}`,
  ];
}

test("the shared POST returns a real ordered merge and updates only integration and the same PR", () => {
  const { fixture, head, parent } = mergeWorld();
  const reply = api(fixture, request(head));
  assert.match(reply.stdout ?? "", HTTP_CREATED);
  const result = branchHead(fixture.origin, "integration");
  assert.ok(result !== null);
  assert.notEqual(result, head);
  assert.equal(
    gitIn(fixture.origin, ["show", "-s", "--format=%P", result]),
    `${parent} ${head}`,
  );
  assert.equal(branchHead(fixture.origin, "main"), parent);
  assert.equal(branchHead(fixture.origin, "agent/issue-7"), head);
  assert.deepEqual(
    fixture.prs.map(({ number, state, mergedHead, mergeOid }) => ({
      number,
      state,
      mergedHead,
      mergeOid,
    })),
    [{ number: PR, state: "MERGED", mergedHead: head, mergeOid: result }],
  );
  assert.ok(reply.stdout?.includes(result));
  assert.equal(gitIn(fixture.origin, ["show", `${result}:first.txt`]), "first");
  assert.equal(
    gitIn(fixture.origin, ["show", `${result}:second.txt`]),
    "second",
  );
  gitIn(fixture.origin, ["update-ref", "-d", "refs/heads/agent/issue-7"]);
  assert.deepEqual(
    fixture.prs.map(({ mergedHead }) => mergedHead),
    [head],
  );
});

test("a second POST is bodyless 204, with no replacement merge or PR head", () => {
  const { fixture, head } = mergeWorld();
  api(fixture, request(head));
  const before = structuredClone(fixture);
  const result = branchHead(fixture.origin, "integration");
  assert.match(api(fixture, request(head)).stdout ?? "", HTTP_UNCHANGED);
  assert.equal(branchHead(fixture.origin, "integration"), result);
  assert.deepEqual(fixture, before);
});

test("conflicting branch POST returns HTTP failure without moving integration or PR metadata", () => {
  const { fixture, head, parent } = mergeWorld();
  const seed = path.join(path.dirname(fixture.origin), "seed");
  sh(
    `git -C ${seed} checkout -q integration && echo conflict > ${seed}/first.txt && git -C ${seed} add first.txt && git -C ${seed} -c user.name=Base -c user.email=base@example.invalid commit -qm conflict && git -C ${seed} push -q origin HEAD:integration`,
  );
  const before = structuredClone(fixture);
  const base = branchHead(fixture.origin, "integration");
  assert.notEqual(base, parent);
  const reply = api(fixture, request(head));
  assert.equal(reply.code, 1);
  assert.match(reply.stdout ?? "", HTTP_CONFLICT);
  assert.equal(branchHead(fixture.origin, "integration"), base);
  assert.equal(branchHead(fixture.origin, "main"), parent);
  assert.deepEqual(fixture, before);
});

for (const malformed of [
  ["repos/o/r/merges", "--method", "POST"],
  ["repos/other/repo/merges", "--method", "POST"],
  ["repos/o/r/unknown"],
  ["repos/o/r/unknown", "--method", "DELETE"],
]) {
  test(`shared fake refuses unsupported ${malformed.join(" ")} with no ref or metadata change`, () => {
    const { fixture, parent } = mergeWorld();
    const before = structuredClone(fixture);
    assert.throws(() => api(fixture, malformed), UNSUPPORTED);
    assert.equal(branchHead(fixture.origin, "integration"), parent);
    assert.equal(branchHead(fixture.origin, "main"), parent);
    assert.deepEqual(fixture, before);
  });
}
