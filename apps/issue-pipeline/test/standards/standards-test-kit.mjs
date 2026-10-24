// @ts-check
// A world for tests of the standards upgrade's entrypoint,
// scripts/standards-upgrade.ts: a temporary pipeline root, a fake gh that
// answers the repository, branch protection and ruleset reads, a local bare
// origin holding a fixture repository's branches and tags, and a config for
// repo o/r pointing at it. `assess` runs the real entrypoint in its own
// process and returns its exit, output and the folder it wrote.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { credentialConfig } from "../credentials-test-kit.mjs";
import { installFakeGh } from "../fake-gh.mjs";
import { isolatedRoot } from "../isolated-root-test-kit.mjs";
import { git } from "../job-git-test-kit.mjs";

const ENTRY = path.join(
  import.meta.dirname,
  "..",
  "..",
  "scripts",
  "standards-upgrade.ts",
);
const ENTRY_MS = 60_000;
const gh = installFakeGh();
const { ghIsRead } = await import("../../src/github.ts");
const { ASSESSMENT } = await import("../../src/standards/schema.ts");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "standards-world-"));
process.on("exit", () => fs.rmSync(work, { recursive: true, force: true }));
let worlds = 0;

/**
 * A fixture repository: each branch's or tag's files, by path.
 * @typedef {object} Fixture
 * @property {Record<string, Record<string, string>>} branches the first is the default
 * @property {Record<string, Record<string, string>>} [tags]
 */

/**
 * A bare origin in a fresh folder holding `fixture`, one commit per ref.
 * @param {Fixture} fixture
 * @returns {{ dir: string, origin: string }}
 */
function originOf(fixture) {
  worlds += 1;
  const dir = path.join(work, `world-${worlds}`);
  const origin = path.join(dir, "origin.git");
  const seed = path.join(dir, "seed");
  const [first = "main"] = Object.keys(fixture.branches);
  git(["init", "--quiet", "--bare", "-b", first, origin]);
  git(["init", "--quiet", "-b", first, seed]);
  const refs = [
    ...Object.entries(fixture.branches).map(([name, files]) => ({
      ref: `refs/heads/${name}`,
      files,
    })),
    ...Object.entries(fixture.tags ?? {}).map(([name, files]) => ({
      ref: `refs/tags/${name}`,
      files,
    })),
  ];
  for (const { ref, files } of refs) {
    git(["-C", seed, "checkout", "--quiet", "--orphan", `seed-${ref}`]);
    git(["-C", seed, "rm", "-r", "-q", "--cached", "--ignore-unmatch", "."]);
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(seed, file)), { recursive: true });
      fs.writeFileSync(path.join(seed, file), text);
    }
    git(["-C", seed, "add", "--", ...Object.keys(files)]);
    git(["-C", seed, "commit", "--quiet", "-m", ref]);
    git(["-C", seed, "push", "--quiet", origin, `HEAD:${ref}`]);
    git(["-C", seed, "clean", "-fdxq"]);
  }
  return { dir, origin };
}

/**
 * Every ref of `origin` and its commit, to show nothing moved.
 * @param {string} origin
 * @returns {string}
 */
function refsOf(origin) {
  return git(["--git-dir", origin, "show-ref"]);
}

/**
 * What the fake GitHub shows: the repository and the default branch's
 * required checks. A null check list makes that read fail as GitHub refuses
 * an account without admin access; an empty one is GitHub's 404.
 * @typedef {object} GitHubView
 * @property {string} [fullName]
 * @property {boolean} [archived]
 * @property {string} [defaultBranch]
 * @property {string[] | null} [protection]
 * @property {string[] | null} [rules]
 */

/** @param {string[] | null | undefined} checks @param {string} when */
function checksReply(checks, when) {
  if (checks === null) {
    return {
      when,
      stderr: "gh: Resource not accessible by integration (HTTP 403)",
      code: 1,
      keep: true,
    };
  }
  if (checks === undefined || checks.length === 0) {
    return {
      when,
      stderr: "gh: Branch not protected (HTTP 404)",
      code: 1,
      keep: true,
    };
  }
  return { when, stdout: JSON.stringify(checks), keep: true };
}

/** @param {GitHubView} view */
function showOnGitHub(view) {
  const branch = view.defaultBranch ?? "main";
  gh.reply([
    checksReply(
      view.protection,
      `repos/o/r/branches/${branch}/protection/required_status_checks`,
    ),
    checksReply(view.rules, `repos/o/r/rules/branches/${branch}`),
    {
      when: "api repos/o/r --jq",
      stdout: JSON.stringify({
        fullName: view.fullName ?? "o/r",
        archived: view.archived ?? false,
        defaultBranch: branch,
      }),
      keep: true,
    },
  ]);
}

/**
 * Runs `standards-upgrade assess` for `fixture` as GitHub shows `view`.
 * @param {Fixture} fixture
 * @param {{ view?: GitHubView, repo?: string, ref?: string }} [options]
 */
function assess(fixture, options = {}) {
  const { dir, origin } = originOf(fixture);
  const config = path.join(dir, "config.json");
  fs.writeFileSync(
    config,
    JSON.stringify({
      repo: "o/r",
      ...credentialConfig("lawd"),
      allowedUsers: ["owner"],
      commands: { test: "true" },
      cloneUrl: origin,
    }),
  );
  showOnGitHub(options.view ?? {});
  const out = path.join(dir, "out");
  fs.mkdirSync(out);
  const before = refsOf(origin);
  const args = [
    ENTRY,
    "assess",
    "--config",
    config,
    "--repo",
    options.repo ?? "o/r",
    "--out",
    out,
  ];
  if (options.ref !== undefined) {
    args.push("--ref", options.ref);
  }
  const result = spawnSync(process.execPath, args, {
    cwd: isolatedRoot,
    encoding: "utf8",
    timeout: ENTRY_MS,
  });
  /** @type {unknown} */
  let line = null;
  if (result.stdout.trim() !== "") {
    line = JSON.parse(result.stdout);
  }
  return {
    code: result.status,
    stderr: result.stderr,
    line,
    out,
    dir,
    written: fs.readdirSync(out).sort(),
    originMoved: refsOf(origin) !== before,
    calls: gh.calls(),
    writes: gh.writes(ghIsRead),
    assessment: () =>
      ASSESSMENT.parse(
        JSON.parse(fs.readFileSync(path.join(out, "assessment.json"), "utf8")),
      ),
    /** @param {string} name */
    text: (name) => fs.readFileSync(path.join(out, name), "utf8"),
  };
}

/**
 * The status of criterion `id` in `assessment`, or undefined.
 * @param {{ criteria: { id: string, status: string }[] }} assessment
 * @param {string} id
 */
function statusOf(assessment, id) {
  return assessment.criteria.find((criterion) => criterion.id === id)?.status;
}

export { assess, statusOf };
