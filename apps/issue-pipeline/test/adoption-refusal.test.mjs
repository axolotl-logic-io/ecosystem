// @ts-check
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  changeApi,
  dirtyWork,
  fixture,
  git,
  readApi,
} from "./adoption-test-kit.mjs";
import { githubComment } from "./fake-gh.mjs";

const { COMMENT } = await import("../src/comments.ts");
const UNKNOWN_VERSION = 99;
const REFUSED = /adoption refused/u;
const ORIGIN_REFUSAL = /origin.url exited|origin identity mismatch/u;
const PR = 42;
const OTHER_PR = 43;
const OTHER_ISSUE = 8;
const HISTORY_LIMIT = 100;
const SHA_LENGTH = 40;
/** @typedef {{ apply: (data: import("./adoption-test-kit.mjs").Api) => void; diagnostic: RegExp }} BadEvidence */
/** @type {Record<string, BadEvidence>} */
const cases = {
  "wrong-repo": {
    apply: (data) => {
      data.actualRepo = "other/repo";
    },
    diagnostic: /actual repository or issue identity mismatch/u,
  },
  "wrong-source": {
    apply: (data) => {
      data.pr.head.ref = "other";
    },
    diagnostic: /PR repository, source or target identity mismatch/u,
  },
  "wrong-target": {
    apply: (data) => {
      data.pr.base.ref = "main";
    },
    diagnostic: /PR repository, source or target identity mismatch/u,
  },
  "pr-mismatch": {
    apply: (data) => {
      data.history = [];
    },
    diagnostic: /PR identity is absent from all-state/u,
  },
  ambiguous: {
    apply: (data) => {
      data.history = [{ number: PR }, { number: OTHER_PR }];
    },
    diagnostic: /history is saturated or ambiguous/u,
  },
  saturated: {
    apply: (data) => {
      data.history = Array.from({ length: HISTORY_LIMIT }, (_, index) => ({
        number: index + 1,
      }));
    },
    diagnostic: /history is saturated or ambiguous/u,
  },
  "malformed-history": {
    apply: (data) => {
      data.history = { incomplete: true };
    },
    diagnostic: /Invalid input: expected array/u,
  },
  "unreadable-pr": {
    apply: (data) => {
      data.mode = "unreadable-pr";
    },
    diagnostic: /PR unavailable/u,
  },
  "changed-head": {
    apply: (data) => {
      data.mode = "changed-head";
    },
    diagnostic: /actual source head differs/u,
  },
  "malformed-pr": {
    apply: (data) => {
      data.pr.head.sha = "invalid";
    },
    diagnostic: /Invalid string: must match pattern/u,
  },
};

for (const [name, bad] of Object.entries(cases)) {
  test(`unsafe ${name} evidence refuses with its actual diagnostic and preserves local work`, () => {
    const place = fixture();
    const before = dirtyWork(place.code);
    changeApi(place, bad.apply);
    const historical = readApi(place).comments;
    assert.throws(() => place.adopt(), bad.diagnostic);
    assert.equal(git(place.code, ["rev-parse", "HEAD"]), before.head);
    assert.equal(git(place.code, ["show", ":local.txt"]), before.index);
    assert.equal(
      fs.readFileSync(path.join(place.code, "local.txt"), "utf8"),
      before.working,
    );
    assert.deepEqual(readApi(place).comments, historical);
    assert.ok(
      fs
        .readdirSync(path.join(place.runDir, "adoption"))
        .some((item) => item.startsWith("snapshot-")),
    );
  });
}

/** @param {ReturnType<typeof fixture>} place @param {string} bad */
function malformedState(place, bad) {
  const legacy = { ...place.legacy, flows: { code: true, wiki: false } };
  switch (bad) {
    case "wrong-issue":
      legacy.number = OTHER_ISSUE;
      break;
    case "unknown-stage":
      legacy.stage = "unrecognized-stage";
      break;
    case "unknown-version":
      legacy.version = UNKNOWN_VERSION;
      break;
    case "malformed-saved-head":
      legacy.headSha = "invalid";
      break;
    case "missing-saved-head":
      legacy.headSha = "e".repeat(SHA_LENGTH);
      break;
    case "wiki-flow-without-identity":
      legacy.flows.wiki = true;
      break;
    case "malformed-state":
      return "<!-- agent-pipeline:state\n{invalid}\n-->";
    case "malformed-pr-binding":
      return '<!-- agent-pipeline:state\n{"version":1,"number":7,"stage":"implement","pr":"not a number"}\n-->';
    default:
      break;
  }
  return `<!-- agent-pipeline:state\n${JSON.stringify(legacy)}\n-->`;
}

for (const bad of [
  "wrong-issue",
  "malformed-state",
  "unknown-stage",
  "malformed-pr-binding",
  "unknown-version",
  "current-conflict",
  "malformed-saved-head",
  "missing-saved-head",
  "wiki-flow-without-identity",
]) {
  test(`${bad} state evidence is not silently adopted`, () => {
    const place = fixture();
    const before = dirtyWork(place.code);
    changeApi(place, (data) => {
      const [comment] = data.comments;
      if (comment === undefined) {
        throw new Error("fixture lacks historical comment");
      }
      comment.body = malformedState(place, bad);
      if (bad === "current-conflict") {
        data.comments.push(
          COMMENT.parse(
            githubComment({
              id: 2,
              nodeId: `${place.cfg.slug}:2`,
              login: place.cfg.mergeAccount,
              created: "2026-10-18T00:00:00Z",
              body: '<!-- agent-pipeline:state\n{"version":2}\n-->',
            }),
          ),
        );
      }
    });
    const historical = readApi(place).comments;
    assert.throws(() => place.adopt(), REFUSED);
    assert.equal(git(place.code, ["rev-parse", "HEAD"]), before.head);
    assert.equal(git(place.code, ["show", ":local.txt"]), before.index);
    assert.deepEqual(readApi(place).comments, historical);
  });
}

test("actual local origin mismatch refuses without losing WIP", () => {
  const place = fixture();
  const before = dirtyWork(place.code);
  git(place.code, ["remote", "set-url", "origin", place.tmp]);
  assert.throws(() => place.adopt(), ORIGIN_REFUSAL);
  assert.equal(git(place.code, ["show", ":local.txt"]), before.index);
  assert.equal(readApi(place).comments.length, 1);
});

test("wiki origin mismatch preserves both checkouts and refuses new authority", () => {
  const place = fixture(true);
  assert.ok(place.wiki);
  const before = dirtyWork(place.wiki);
  git(place.wiki, ["remote", "set-url", "origin", place.origins.origin]);
  assert.throws(() => place.adopt(), ORIGIN_REFUSAL);
  assert.equal(git(place.wiki, ["rev-parse", "HEAD"]), before.head);
  assert.equal(git(place.wiki, ["show", ":local.txt"]), before.index);
  assert.equal(readApi(place).comments.length, 1);
});

test("conflicting historical PR identities refuse rather than silently selecting the newest", () => {
  const place = fixture();
  dirtyWork(place.code);
  changeApi(place, (data) =>
    data.comments.push(
      COMMENT.parse(
        githubComment({
          id: 2,
          login: "old-bot",
          created: "2026-10-18T00:00:00Z",
          body: `<!-- agent-pipeline:state\n${JSON.stringify({ ...place.legacy, pr: OTHER_PR })}\n-->`,
        }),
      ),
    ),
  );
  const { comments } = readApi(place);
  assert.throws(() => place.adopt(), REFUSED);
  assert.deepEqual(readApi(place).comments, comments);
});
