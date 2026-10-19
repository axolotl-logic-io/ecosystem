// @ts-check
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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

const ISSUE = 7;
const PR = 42;

const { readClaimState, readWriteState } = await import(
  "../src/saved-state.ts"
);
const { listComments } = await import("../src/comments.ts");
const { readWriteAuthority } = await import("../src/write-authority.ts");
const { saveIssueState } = await import("../src/ops/save-state.ts");
const UNCERTAIN = /publication is uncertain/u;
const REFUSED = /adoption refused/u;
const STOPPED = /stopped for explicit PR\/completion reconciliation/u;
const PROVENANCE = /provenance/u;

/** @param {ReturnType<typeof fixture>} place */
function evidenceOf(place) {
  return path.join(place.runDir, "adoption", "plan.json");
}

for (const mode of [
  "lost-after-post",
  "provenance-failure",
  "interrupted-validation",
]) {
  test(`interrupted ${mode} reuses immutable evidence and never duplicates or resets authority`, () => {
    const place = fixture();
    const local = dirtyWork(place.code);
    changeApi(place, (data) => {
      data.mode = mode;
    });
    assert.throws(() => place.adopt(), REFUSED);
    const evidence = fs.readFileSync(evidenceOf(place), "utf8");
    changeApi(place, (data) => {
      data.mode = "normal";
    });
    const result = place.adopt();
    assert.equal(result.reused, mode !== "interrupted-validation");
    assert.equal(fs.readFileSync(evidenceOf(place), "utf8"), evidence);
    assert.equal(readApi(place).comments.length, 2);
    assert.equal(git(place.code, ["rev-parse", "HEAD"]), local.head);
    assert.equal(git(place.code, ["show", ":local.txt"]), local.index);
    assert.equal(
      fs.readFileSync(path.join(place.code, "local.txt"), "utf8"),
      local.working,
    );
  });
}

test("a lost publication with no visible saved state never blindly posts again", () => {
  const place = fixture();
  dirtyWork(place.code);
  changeApi(place, (data) => {
    data.mode = "lost-before-post";
  });
  assert.throws(() => place.adopt(), REFUSED);
  assert.throws(() => place.adopt(), UNCERTAIN);
  assert.equal(readApi(place).comments.length, 1);
  assert.equal(
    readApi(place).calls.filter((args) => args.includes("POST")).length,
    1,
  );
});

for (const evidence of [
  "missing-bundle",
  "modified-bundle",
  "changed-work",
  "changed-pr",
  "foreign-editor",
  "conflicting-state",
]) {
  test(`replay safely refuses ${evidence} without changing saved state or retained work`, () => {
    const place = fixture();
    dirtyWork(place.code);
    place.adopt();
    const plan = JSON.parse(fs.readFileSync(evidenceOf(place), "utf8"));
    if (evidence === "missing-bundle") {
      fs.unlinkSync(plan.work.trees[0].bundle.file);
    }
    if (evidence === "modified-bundle") {
      fs.appendFileSync(plan.work.trees[0].bundle.file, "changed");
    }
    if (evidence === "changed-work") {
      fs.writeFileSync(path.join(place.code, "local.txt"), "later WIP\n");
    }
    changeApi(place, (data) => {
      if (evidence === "changed-pr") {
        data.pr.state = "closed";
      }
      if (evidence === "foreign-editor") {
        data.mode = "foreign-editor";
      }
      if (evidence === "conflicting-state") {
        const last = data.comments.at(-1);
        if (last === undefined) {
          throw new Error("fixture lacks current state");
        }
        const { body } = last;
        last.body = body?.replace('"stage":"author"', '"stage":"implement"');
      }
    });
    const { comments } = readApi(place);
    const local = fs.readFileSync(path.join(place.code, "local.txt"), "utf8");
    assert.throws(() => place.adopt(), REFUSED);
    assert.deepEqual(readApi(place).comments, comments);
    assert.equal(
      fs.readFileSync(path.join(place.code, "local.txt"), "utf8"),
      local,
    );
  });
}

test("unmerged index preservation failure retains conflict stages and partial evidence; an explicit repair can retry without overwriting it", () => {
  const place = fixture();
  dirtyWork(place.code);
  const ShaLength = 40;
  const blob = git(place.code, ["rev-parse", "HEAD:local.txt"]);
  const input = `0 ${"0".repeat(ShaLength)}\tlocal.txt\n100644 ${blob} 1\tlocal.txt\n100644 ${blob} 2\tlocal.txt\n100644 ${blob} 3\tlocal.txt\n`;
  execFileSync("git", ["-C", place.code, "update-index", "--index-info"], {
    input,
  });
  const conflicts = git(place.code, ["ls-files", "--unmerged"]);
  assert.throws(() => place.adopt(), REFUSED);
  assert.equal(git(place.code, ["ls-files", "--unmerged"]), conflicts);
  assert.equal(readApi(place).comments.length, 1);
  const root = path.dirname(evidenceOf(place));
  const partial = fs
    .readdirSync(root)
    .find((name) => name.startsWith("snapshot-"));
  assert.ok(partial);
  const saved = fs.readFileSync(
    path.join(root, partial, "comments.json"),
    "utf8",
  );
  // This is an operator repair in a fixture, not cleanup performed by adoption.
  git(place.code, ["read-tree", "HEAD"]);
  place.adopt();
  assert.equal(
    fs.readFileSync(path.join(root, partial, "comments.json"), "utf8"),
    saved,
  );
});

test("wiki identity, private commits and separate staged/working changes are retained alongside code without publishing", () => {
  const place = fixture(true);
  assert.ok(place.wiki);
  const wiki = dirtyWork(place.wiki);
  const code = dirtyWork(place.code);
  assert.ok(place.origins.wikiOrigin);
  const refs = git(place.origins.wikiOrigin, ["show-ref"]);
  const result = place.adopt();
  const plan = JSON.parse(fs.readFileSync(result.evidence, "utf8"));
  const savedWiki = plan.work.trees.find(
    (/** @type {{ kind: string }} */ tree) => tree.kind === "wiki",
  );
  assert.equal(savedWiki.head, wiki.head);
  assert.equal(savedWiki.patches.length, 2);
  assert.equal(plan.truth.wiki.head, wiki.head);
  assert.equal(git(place.origins.wikiOrigin, ["show-ref"]), refs);
  assert.equal(git(place.wiki, ["show", ":local.txt"]), wiki.index);
  assert.equal(git(place.code, ["show", ":local.txt"]), code.index);
  assert.equal(place.adopt().reused, true);
});

test("genuine fetched merge truth permanently closes code, but supplies no completion or security authority", () => {
  const place = fixture();
  dirtyWork(place.code);
  git(place.origins.origin, [
    "update-ref",
    `refs/heads/${place.cfg.baseBranch}`,
    place.remote,
  ]);
  changeApi(place, (data) => {
    data.pr.state = "closed";
    data.pr.merged = true;
    data.pr.merged_at = "2026-10-18T00:00:00Z";
    data.pr.merge_commit_sha = place.remote;
  });
  place.request.restart = "stopped";
  const result = place.adopt();
  assert.deepEqual(result.state.codeMerged, { pr: PR, sha: place.remote });
  assert.equal(result.state.merged, null);
  assert.equal(result.state.security, null);
  assert.equal(result.state.hardened, null);
  assert.equal(readWriteAuthority(place.cfg, ISSUE).codeWritable, false);
  assert.throws(
    () => readClaimState(place.cfg, ISSUE, listComments(place.cfg, ISSUE)),
    STOPPED,
  );
  saveIssueState(place.cfg, ISSUE, {
    ...result.state,
    adoption: null,
    codeMerged: null,
  });
  assert.equal(readWriteState(place.cfg, ISSUE).adoption?.blocked, true);
  assert.equal(readWriteState(place.cfg, ISSUE).codeMerged?.sha, place.remote);
});

test("unverifiable merge ancestry refuses rather than importing a historical merged claim", () => {
  const place = fixture();
  dirtyWork(place.code);
  changeApi(place, (data) => {
    data.pr.state = "closed";
    data.pr.merged = true;
    data.pr.merged_at = "2026-10-18T00:00:00Z";
    data.pr.merge_commit_sha = place.remote;
  });
  place.request.restart = "stopped";
  assert.throws(() => place.adopt(), REFUSED);
  assert.equal(readApi(place).comments.length, 1);
});

test("only confirmed current provenance can authorize a subsequent stage", () => {
  const place = fixture();
  changeApi(place, (data) => {
    data.mode = "foreign-editor";
  });
  assert.throws(() => place.adopt(), PROVENANCE);
  assert.throws(
    () => readClaimState(place.cfg, ISSUE, listComments(place.cfg, ISSUE)),
    PROVENANCE,
  );
});
