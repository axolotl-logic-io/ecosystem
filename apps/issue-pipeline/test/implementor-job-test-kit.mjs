// @ts-check
// The implementor's stage job fixtures (#414): the ops replies for issue #7
// claimed at implement, with the push op's reply, a way to change the
// claimed state once the place (and its origin) exists, and an issue branch
// on the origin whose only commit past its spec tests removes the spec
// draft, as the spec writer's publication leaves it.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { refOf } from "./job-git-test-kit.mjs";
import { repliesAt } from "./job-test-kit.mjs";

/** @import { Place } from "./job-test-kit.mjs" */

// The head the push op reports.
const PUSHED = "bbbbbbb";
const BRANCH = "refs/heads/agent/issue-7";
const DRAFT = ".issue-pipeline/spec-draft.md";
// Commits made outside a job need a name and no signing.
const IDENTITY = [
  "-c",
  "user.name=Seed",
  "-c",
  "user.email=seed@example.com",
  "-c",
  "commit.gpgsign=false",
];

/** @param {unknown} value @returns {Record<string, unknown>} */
function recordOf(value) {
  if (typeof value === "object" && value !== null) {
    return { ...value };
  }
  return {};
}

/** @param {unknown} reply a claim's reply @param {Record<string, unknown>} fields @returns {Record<string, unknown>} the reply with `fields` set in its state */
function claimed(reply, fields) {
  const claim = recordOf(reply);
  const { state } = claim;
  return { ...claim, state: { ...recordOf(state), ...fields } };
}

/**
 * The replies for #7 claimed at implement with `fields` in its state, and a
 * push whose branch changes code when `codeChanged`.
 * @param {Record<string, unknown>} [fields]
 * @param {boolean} [codeChanged]
 * @returns {{ claim: { paths?: object } } & Record<string, unknown>}
 */
function implementReplies(fields = {}, codeChanged = true) {
  const replies = repliesAt("implement");
  const push = { ok: true, headSha: PUSHED, codeChanged, wikiAhead: 0 };
  return { ...replies, claim: claimed(replies.claim, fields), push };
}

/** @param {Place} place @param {Record<string, unknown>} fields sets `fields` in the state the claim gives */
function claimWith(place, fields) {
  const file = path.join(place.root, "replies.json");
  const replies = recordOf(JSON.parse(fs.readFileSync(file, "utf8")));
  const { claim } = replies;
  const edited = { ...replies, claim: claimed(claim, fields) };
  fs.writeFileSync(file, JSON.stringify(edited));
}

/** @param {string} dir @param {readonly string[]} args */
function git(dir, args) {
  execFileSync("git", [...IDENTITY, "-C", dir, ...args], { encoding: "utf8" });
}

/**
 * Pushes #7's branch to `origin`: a commit with the spec draft (the spec's
 * tests, as `specTestsSha`), then one that removes it; returns the first.
 * @param {string} origin
 * @returns {string}
 */
function draftRemovedOnOrigin(origin) {
  const seed = `${origin}-seed`;
  fs.mkdirSync(path.join(seed, path.dirname(DRAFT)), { recursive: true });
  fs.writeFileSync(path.join(seed, DRAFT), "## Behaviour\n");
  git(seed, ["add", DRAFT]);
  git(seed, ["commit", "--quiet", "-m", "spec draft"]);
  git(seed, ["push", "--quiet", origin, `HEAD:${BRANCH}`]);
  const specTestsSha = refOf(origin, BRANCH);
  git(seed, ["rm", "--quiet", DRAFT]);
  git(seed, ["commit", "--quiet", "-m", "drop the spec draft"]);
  git(seed, ["push", "--quiet", origin, `HEAD:${BRANCH}`]);
  git(seed, ["reset", "--quiet", "--hard", "HEAD~2"]);
  return specTestsSha;
}

export { claimed, claimWith, draftRemovedOnOrigin, implementReplies, PUSHED };
