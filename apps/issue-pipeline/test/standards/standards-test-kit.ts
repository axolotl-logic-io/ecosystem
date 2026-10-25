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
import type { Assessment } from "../../src/standards/schema.ts";
import { credentialConfig } from "../credentials-test-kit.ts";
import { installFakeGh } from "../fake-gh.ts";
import { isolatedRoot } from "../isolated-root-test-kit.ts";
import { git } from "../job-git-test-kit.ts";

const ENTRY = path.join(
  import.meta.dirname,
  "..",
  "..",
  "scripts",
  "standards-upgrade.ts",
);
const ENTRY_MS = 60_000;
const gh = installFakeGh();
const { ghIsRead }: typeof import("../../src/github.ts") = await import(
  "../../src/github.ts"
);
const { ASSESSMENT }: typeof import("../../src/standards/schema.ts") =
  await import("../../src/standards/schema.ts");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "standards-world-"));
process.on("exit", () => fs.rmSync(work, { recursive: true, force: true }));
let worlds = 0;

// A fixture repository: each branch's or tag's files, by path.
interface Fixture {
  // the first is the default
  branches: Record<string, Record<string, string>>;
  tags?: Record<string, Record<string, string>>;
}

// A bare origin in a fresh folder holding `fixture`, one commit per ref.
function originOf(fixture: Fixture): { dir: string; origin: string } {
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

// Every ref of `origin` and its commit, to show nothing moved.
function refsOf(origin: string): string {
  return git(["--git-dir", origin, "show-ref"]);
}

// What the fake GitHub shows: the repository and the default branch's
// required checks. A null check list makes that read fail as GitHub refuses
// an account without admin access; an empty one is GitHub's 404.
interface GitHubView {
  fullName?: string;
  archived?: boolean;
  defaultBranch?: string;
  protection?: string[] | null;
  rules?: string[] | null;
}

function checksReply(
  checks: string[] | null | undefined,
  when: string,
):
  | {
      when: string;
      stderr: string;
      code: number;
      keep: boolean;
      stdout?: never;
    }
  | {
      when: string;
      stdout: string;
      keep: boolean;
      stderr?: never;
      code?: never;
    } {
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

function showOnGitHub(view: GitHubView): void {
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

// What one assess run did: its exit code, stderr and printed line, its out
// folder and the files written there, its folder and config, whether the
// origin's refs moved, the gh calls and writes it made, and readers of its
// assessment and of a file in its out folder.
interface Assessed {
  code: number | null;
  stderr: string;
  line: unknown;
  out: string;
  dir: string;
  config: string;
  credentialsEnvFile: string;
  written: string[];
  originMoved: boolean;
  calls: string[][];
  writes: string[][];
  assessment: () => Assessment;
  text: (name: string) => string;
}

// Runs `standards-upgrade assess` for `fixture` as GitHub shows `view`, with
// `args` after the usual ones (`--static` by default) and `env` added to
// its environment.
function assess(
  fixture: Fixture,
  options: {
    view?: GitHubView;
    repo?: string;
    ref?: string;
    args?: string[];
    env?: Record<string, string>;
  } = {},
): Assessed {
  const { dir, origin } = originOf(fixture);
  const config = path.join(dir, "config.json");
  const credentials = credentialConfig("lawd");
  fs.writeFileSync(
    config,
    JSON.stringify({
      repo: "o/r",
      ...credentials,
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
  args.push(...(options.args ?? ["--static"]));
  const result = spawnSync(process.execPath, args, {
    cwd: isolatedRoot,
    encoding: "utf8",
    timeout: ENTRY_MS,
    env: { ...process.env, ...options.env },
  });
  let line: unknown = null;
  if (result.stdout.trim() !== "") {
    line = JSON.parse(result.stdout);
  }
  return {
    code: result.status,
    stderr: result.stderr,
    line,
    out,
    dir,
    config,
    credentialsEnvFile: credentials.credentialsEnvFile,
    written: fs.readdirSync(out).sort(),
    originMoved: refsOf(origin) !== before,
    calls: gh.calls(),
    writes: gh.writes(ghIsRead),
    assessment: (): Assessment =>
      ASSESSMENT.parse(
        JSON.parse(fs.readFileSync(path.join(out, "assessment.json"), "utf8")),
      ),
    text: (name: string): string =>
      fs.readFileSync(path.join(out, name), "utf8"),
  };
}

// The status of criterion `id` in `assessment`, or undefined.
function statusOf(
  assessment: { criteria: { id: string; status: string }[] },
  id: string,
): string | undefined {
  return assessment.criteria.find((criterion) => criterion.id === id)?.status;
}

export type { Assessed, Fixture };
export { assess, statusOf };
