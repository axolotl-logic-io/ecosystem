// @ts-check
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import {
  BRANCH,
  changeApi,
  dirtyWork,
  fixture,
  git,
  readApi,
} from "./adoption-test-kit.mjs";

const { paths } = await import("../src/config.ts");
const { readWriteState } = await import("../src/saved-state.ts");
const { adoptLegacy } = await import("../src/adoption.ts");
const ISSUE = 7;
const OTHER_ISSUE = 8;
const REFUSED = /adoption refused/u;
const RESTART = /operator must choose an explicit/u;
const WIKI_HEAD = /retained wiki head is not reconciled/u;

/** @param {ReturnType<typeof fixture>} place */
function rootOf(place) {
  return path.join(place.runDir, "adoption");
}

for (const missing of [
  "publication-marker",
  "malformed-plan",
  "historical-state",
]) {
  test(`missing or changed ${missing} evidence refuses a published replay without resetting it`, () => {
    const place = fixture();
    dirtyWork(place.code);
    place.adopt();
    if (missing === "publication-marker") {
      fs.unlinkSync(path.join(rootOf(place), "publication-started.json"));
    }
    if (missing === "malformed-plan") {
      fs.writeFileSync(path.join(rootOf(place), "plan.json"), "invalid json");
    }
    if (missing === "historical-state") {
      changeApi(place, (data) => {
        const [old] = data.comments;
        if (old !== undefined) {
          old.body += " changed";
        }
      });
    }
    const { comments } = readApi(place);
    assert.throws(() => place.adopt(), REFUSED);
    assert.deepEqual(readApi(place).comments, comments);
    assert.equal(readWriteState(place.cfg, ISSUE).stage, "author");
  });
}

test("completed preservation from an interrupted preparation is verified and reused, not overwritten", () => {
  const place = fixture();
  dirtyWork(place.code);
  assert.throws(
    () => adoptLegacy(place.cfg, { ...place.request, restart: undefined }),
    RESTART,
  );
  const [snapshot] = fs
    .readdirSync(rootOf(place))
    .filter((name) => name.startsWith("snapshot-"));
  assert.ok(snapshot);
  const inventory = fs.readFileSync(
    path.join(rootOf(place), snapshot, "inventory.json"),
    "utf8",
  );
  const original = JSON.parse(inventory);
  const result = place.adopt();
  const plan = JSON.parse(fs.readFileSync(result.evidence, "utf8"));
  assert.equal(plan.work.trees[0].bundle.file, original.trees[0].bundle.file);
  assert.equal(
    fs.readFileSync(
      path.join(rootOf(place), snapshot, "inventory.json"),
      "utf8",
    ),
    inventory,
  );
});

test("a newer private wiki mirror head is preserved but cannot be silently selected or lost", () => {
  const place = fixture(true);
  assert.ok(place.wiki);
  const selected = dirtyWork(place.wiki);
  const mirror = paths.wikiMirror(place.cfg);
  fs.mkdirSync(path.dirname(mirror), { recursive: true });
  git(place.tmp, ["clone", "--bare", place.wiki, mirror]);
  const later = path.join(place.tmp, "later-wiki");
  git(place.tmp, ["clone", mirror, later]);
  fs.writeFileSync(path.join(later, "later.md"), "newer retained wiki work\n");
  git(later, ["add", "later.md"]);
  git(later, ["commit", "-m", "Later private wiki work"]);
  const retained = git(later, ["rev-parse", "HEAD"]);
  git(mirror, ["fetch", later, `HEAD:refs/heads/${BRANCH}`]);
  assert.throws(() => place.adopt(), WIKI_HEAD);
  assert.equal(readApi(place).comments.length, 1);
  assert.equal(git(mirror, ["rev-parse", BRANCH]), retained);
  assert.equal(git(place.wiki, ["rev-parse", "HEAD"]), selected.head);
  assert.ok(
    fs.readdirSync(rootOf(place)).some((name) => name.startsWith("snapshot-")),
  );
});

test("the installed CLI entry can publish current state and does not mutate unrelated retained issue work", () => {
  const place = fixture();
  dirtyWork(place.code);
  const other = paths.jobRepo(place.cfg, OTHER_ISSUE, "implement");
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, "rescue.txt"), "unresolved rescue lane\n");
  const result = spawnSync(
    process.execPath,
    [
      new URL("../dist/adopt.mjs", import.meta.url).pathname,
      "--config",
      place.config,
      "--issue",
      String(ISSUE),
      "--branch",
      BRANCH,
      "--code-path",
      place.code,
      "--restart-stage",
      "author",
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).ok, true);
  assert.equal(readWriteState(place.cfg, ISSUE).stage, "author");
  assert.equal(
    fs.readFileSync(path.join(other, "rescue.txt"), "utf8"),
    "unresolved rescue lane\n",
  );
  const mutations = readApi(place).calls.filter(
    (args) => args.includes("POST") || args.includes("PATCH"),
  );
  assert.equal(mutations.length, 1);
  assert.ok(
    mutations[0]?.includes(`repos/${place.cfg.repo}/issues/${ISSUE}/comments`),
  );
});

test("a real merged PR with a deleted source remains stopped and cannot authorize a second code lane", () => {
  const place = fixture();
  dirtyWork(place.code);
  git(place.origins.origin, [
    "update-ref",
    `refs/heads/${place.cfg.baseBranch}`,
    place.remote,
  ]);
  git(place.origins.origin, ["update-ref", "-d", `refs/heads/${BRANCH}`]);
  changeApi(place, (data) => {
    data.pr.state = "closed";
    data.pr.merged = true;
    data.pr.merged_at = "2026-10-18T00:00:00Z";
    data.pr.merge_commit_sha = place.remote;
  });
  place.request.restart = "stopped";
  const refs = git(place.origins.origin, ["show-ref"]);
  const result = place.adopt();
  assert.equal(result.state.codeMerged?.sha, place.remote);
  assert.equal(result.state.adoption?.blocked, true);
  assert.equal(result.state.merged, null);
  assert.equal(git(place.origins.origin, ["show-ref"]), refs);
});
