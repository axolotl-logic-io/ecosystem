// The parts of gh that the buddy flow tests' runtime, tasks and ops use
// beyond the signal reads fake-gh.ts answers: whole paginated comment
// listings (`--paginate --jq '.[] | @json'`), comment edits, plain resource
// reads (issues, collaborators), the repository's git database, which is
// the real local bare origin in FAKE_GH_ORIGIN, and `gh pr` for the item's
// pull request. flowCall answers from the world and says whether the call
// was one of these.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";
import { z } from "zod";
import type { FakeComment, FakeIssue, World } from "./fake-github-world.ts";

const COMMENTS = /^repos\/[^/]+\/[^/]+\/issues\/(?<number>\d+)\/comments\?/u;
const REPO_COMMENTS = /^repos\/[^/]+\/[^/]+\/issues\/comments\?/u;
const EDITED = /^repos\/[^/]+\/[^/]+\/issues\/comments\/(?<id>\d+)$/u;
const ISSUE = /^repos\/[^/]+\/[^/]+\/issues\/(?<number>\d+)$/u;
const COLLABORATOR = /^repos\/[^/]+\/[^/]+\/collaborators\/(?<login>[^/]+)$/u;
const REF = /^repos\/[^/]+\/[^/]+\/git\/ref\/(?<ref>.+)$/u;
const GIT_COMMIT = /^repos\/[^/]+\/[^/]+\/git\/commits\/(?<sha>[0-9a-f]{40})$/u;
const NEW_COMMIT = /^repos\/[^/]+\/[^/]+\/git\/commits$/u;
const NEW_REF = /^repos\/[^/]+\/[^/]+\/git\/refs$/u;
const BODY = /^body=(?<body>[\s\S]*)$/u;
const COMMIT_INPUT = z.object({
  message: z.string(),
  tree: z.string(),
  parents: z.array(z.string()),
});
const REF_INPUT = z.object({ ref: z.string(), sha: z.string() });
// Written comments and events are dated from this instant, a second apart
// by id, as fake-gh.ts dates posted comments.
const POSTED_FROM = Date.parse("2026-10-25T12:00:00Z");
const MS_PER_SECOND = 1000;

type Pull = NonNullable<World["pulls"]>[number];

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function origin(): string {
  const { FAKE_GH_ORIGIN: dir } = process.env;
  if (dir === undefined || dir === "") {
    return fail("fake gh: FAKE_GH_ORIGIN is not set");
  }
  return dir;
}

function git(args: string[]): { ok: boolean; out: string } {
  const run = spawnSync("git", ["-C", origin(), ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...Object.fromEntries([
        ["GIT_AUTHOR_NAME", "GitHub"],
        ["GIT_AUTHOR_EMAIL", "noreply@github.test"],
        ["GIT_COMMITTER_NAME", "GitHub"],
        ["GIT_COMMITTER_EMAIL", "noreply@github.test"],
      ]),
    },
  });
  return { ok: run.status === 0, out: run.stdout.trim() };
}

function restComment(
  world: World,
  issue: FakeIssue,
  item: FakeComment,
): object {
  return Object.fromEntries([
    ["id", item.id],
    ["node_id", `IC_${item.id}`],
    ["body", item.body],
    ["user", { login: item.author }],
    ["created_at", item.createdAt],
    ["updated_at", item.createdAt],
    [
      "issue_url",
      `https://api.github.com/repos/${world.repo}/issues/${issue.number}`,
    ],
  ]);
}

function endpointOf(args: readonly string[]): string {
  return args.find((arg) => arg.startsWith("repos/")) ?? "";
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  if (at < 0) {
    return undefined;
  }
  return args[at + 1];
}

// `--paginate ... --jq '.[] | @json'`: one comment per line.
function paginated(world: World, args: readonly string[]): boolean {
  if (!args.includes("--paginate")) {
    return false;
  }
  const endpoint = endpointOf(args);
  const { number } = COMMENTS.exec(endpoint)?.groups ?? {};
  let rows: { issue: FakeIssue; item: FakeComment }[] = [];
  if (number !== undefined) {
    const issue = world.issues.find((item) => String(item.number) === number);
    if (issue !== undefined) {
      rows = issue.comments.map((item) => ({ issue, item }));
    }
  } else if (REPO_COMMENTS.test(endpoint)) {
    rows = world.issues.flatMap((issue) =>
      issue.comments.map((item) => ({ issue, item })),
    );
  } else {
    return fail(`fake gh: unsupported listing ${endpoint}`);
  }
  for (const { issue, item } of rows.sort((a, b) => a.item.id - b.item.id)) {
    print(restComment(world, issue, item));
  }
  return true;
}

// An issue as the REST API lists it.
interface IssueRow {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  user: { login: string };
  labels: { name: string }[];
}

// A pull request as `gh pr list --json` prints it.
interface PullRow {
  number: number;
  headRefName: string;
  baseRefName: string;
  title: string;
  body: string;
  state: Pull["state"];
  isDraft: boolean;
  author: { login: string };
  headRefOid: string;
  mergeCommit: { oid: string } | null;
}

const START_LISTING = `labels=${encodeURIComponent("start:implement")}`;

function issueState(issue: FakeIssue): IssueRow["state"] {
  if (issue.closed === undefined) {
    return "open";
  }
  return "closed";
}

function issueRow(issue: FakeIssue): IssueRow {
  return {
    number: issue.number,
    title: issue.title ?? `Issue ${issue.number}`,
    body: issue.body ?? "",
    state: issueState(issue),
    user: { login: issue.author ?? "someone" },
    labels: issue.labels.map((name) => ({ name })),
  };
}

function issueGet(world: World, args: readonly string[], number: string): void {
  const issue = world.issues.find((item) => String(item.number) === number);
  if (issue === undefined) {
    fail("gh: Not Found (HTTP 404)");
  }
  const jq = flagValue(args, "--jq");
  if (jq === undefined) {
    print(issueRow(issue));
    return;
  }
  if (jq === "{state}" || jq === ".state") {
    if (jq === ".state") {
      print(issueState(issue));
      return;
    }
    print({ state: issueState(issue) });
    return;
  }
  fail(`fake gh: unsupported --jq ${jq}`);
}

function gitGet(endpoint: string): boolean {
  const { ref } = REF.exec(endpoint)?.groups ?? {};
  if (ref !== undefined) {
    // Signal-only fixtures have no coordination refs. Flow fixtures read
    // their actual Git database; no successful owner is fabricated here.
    const { FAKE_GH_ORIGIN: source } = process.env;
    if (
      (source === undefined || source === "") &&
      ref.startsWith("heads/pipeline-coordination/")
    ) {
      return fail("gh: Not Found (HTTP 404)");
    }
    const read = git(["rev-parse", "--verify", "--quiet", `refs/${ref}`]);
    if (!read.ok) {
      return fail("gh: Not Found (HTTP 404)");
    }
    print({ ref: `refs/${ref}`, object: { sha: read.out } });
    return true;
  }
  const { sha } = GIT_COMMIT.exec(endpoint)?.groups ?? {};
  if (sha !== undefined) {
    const tree = git(["rev-parse", "--verify", "--quiet", `${sha}^{tree}`]);
    if (!tree.ok) {
      return fail("gh: Not Found (HTTP 404)");
    }
    print({ sha, tree: { sha: tree.out } });
    return true;
  }
  return false;
}

// A plain `gh api <path>` read.
function plainGet(world: World, args: readonly string[]): boolean {
  const endpoint = endpointOf(args);
  const { number } = ISSUE.exec(endpoint)?.groups ?? {};
  if (number !== undefined) {
    issueGet(world, args, number);
    return true;
  }
  const { login } = COLLABORATOR.exec(endpoint)?.groups ?? {};
  if (login !== undefined) {
    const found = (world.collaborators ?? []).some(
      (name) => name.toLowerCase() === login.toLowerCase(),
    );
    if (!found) {
      return fail("gh: Not Found (HTTP 404)");
    }
    return true;
  }
  return gitGet(endpoint);
}

// The git database writes: a new commit object and a new ref, which fails
// when the ref exists.
function gitWrite(args: readonly string[]): boolean {
  const endpoint = endpointOf(args);
  if (!args.includes("--input")) {
    return false;
  }
  const input: unknown = JSON.parse(fs.readFileSync(0, "utf8"));
  if (NEW_COMMIT.test(endpoint)) {
    const { message, tree, parents } = COMMIT_INPUT.parse(input);
    const made = git([
      "commit-tree",
      tree,
      ...parents.flatMap((parent) => ["-p", parent]),
      "-m",
      message,
    ]);
    if (!made.ok) {
      return fail("gh: HTTP 422: Unprocessable Entity");
    }
    print({ sha: made.out, tree: { sha: tree } });
    return true;
  }
  if (NEW_REF.test(endpoint)) {
    const { ref, sha } = REF_INPUT.parse(input);
    if (!git(["update-ref", ref, sha, ""]).ok) {
      return fail("gh: HTTP 422: Reference already exists");
    }
    print({ ref, object: { sha } });
    return true;
  }
  return false;
}

// A comment edit.
function commentEdit(world: World, args: readonly string[]): boolean {
  const { id } = EDITED.exec(endpointOf(args))?.groups ?? {};
  if (id === undefined || !args.includes("PATCH")) {
    return false;
  }
  const field = args.find((arg) => BODY.test(arg)) ?? "";
  const { body = "" } = BODY.exec(field)?.groups ?? {};
  const item = world.issues
    .flatMap((issue) => issue.comments)
    .find((comment) => String(comment.id) === id);
  if (item === undefined) {
    return fail("gh: Not Found (HTTP 404)");
  }
  item.body = body;
  return true;
}

function nextPull(world: World): number {
  const numbers = [
    ...world.issues.map((issue) => issue.number),
    ...(world.pulls ?? []).map((pull) => pull.number),
  ];
  return Math.max(0, ...numbers) + 1;
}

// The PR as GitHub shows it from the origin's refs: an open PR whose head
// commit is on its base branch, as a fast-forward push of the base puts it,
// reads merged, with that head as its merge commit.
function pullRow(pull: Pull): PullRow {
  const head = git(["rev-parse", `refs/heads/${pull.head}`]).out;
  let { state } = pull;
  let mergeCommit: PullRow["mergeCommit"] = null;
  if (
    state === "OPEN" &&
    head !== "" &&
    git(["merge-base", "--is-ancestor", head, `refs/heads/${pull.base}`]).ok
  ) {
    state = "MERGED";
    mergeCommit = { oid: head };
  }
  return {
    number: pull.number,
    headRefName: pull.head,
    baseRefName: pull.base,
    title: pull.title,
    body: pull.body,
    state,
    isDraft: pull.isDraft,
    author: { login: pull.author },
    headRefOid: head,
    mergeCommit,
  };
}

function postedAt(id: number): string {
  return new Date(POSTED_FROM + id * MS_PER_SECOND).toISOString();
}

// `gh issue close N -R R --reason REASON [--comment TEXT]` by `login`: the
// comment, then the close, of an open issue.
function issueClose(
  world: World,
  args: readonly string[],
  login: string,
): boolean {
  if (args[0] !== "issue" || args[1] !== "close") {
    return false;
  }
  const issue = world.issues.find((item) => String(item.number) === args[2]);
  if (issue === undefined || issue.closed !== undefined) {
    return fail("gh: issue not found or not open");
  }
  const comment = flagValue(args, "--comment");
  if (comment !== undefined) {
    issue.comments.push({
      id: world.nextId,
      author: login,
      body: comment,
      editor: null,
      createdAt: postedAt(world.nextId),
    });
    world.nextId += 1;
  }
  issue.closed = { by: login, reason: flagValue(args, "--reason") ?? "" };
  issue.events.push({
    id: world.nextId,
    event: "closed",
    label: null,
    actor: login,
    viaApp: false,
    createdAt: postedAt(world.nextId),
  });
  world.nextId += 1;
  return true;
}

// `gh pr list --head B --state S`, `gh pr view N` and `gh pr create`, by
// the token's login.
// gh's exit status for failing and for pending checks.
const CHECKS_FAILING = 1;
const CHECKS_PENDING = 8;
const CHECK_STATES = {
  pass: "SUCCESS",
  fail: "FAILURE",
  pending: "PENDING",
  skipping: "SKIPPED",
  cancel: "CANCELLED",
} as const;

// The required checks on PR `number`'s head as the origin has it, as
// `gh pr checks --required --json` prints them and exits.
function requiredChecks(world: World, number: string | undefined): boolean {
  const found = (world.pulls ?? []).find(
    (pull) => String(pull.number) === number,
  );
  if (found === undefined) {
    return fail("gh: Could not resolve to a PullRequest");
  }
  const reply = world.checksReply;
  const after = reply?.afterComment ?? [];
  if (
    reply !== undefined &&
    (after.length === 0 ||
      world.issues.some((issue) =>
        issue.comments.some((comment) =>
          after.every((part) => comment.body.includes(part)),
        ),
      ))
  ) {
    if (
      reply.moveHeadTo !== undefined &&
      !git(["update-ref", `refs/heads/${found.head}`, reply.moveHeadTo]).ok
    ) {
      return fail("fake gh: could not move the PR head during its CI read");
    }
    process.stdout.write(reply.stdout);
    process.stderr.write(reply.stderr);
    process.exitCode = reply.code;
    return true;
  }
  const { headRefOid } = pullRow(found);
  const checks = world.checks?.[headRefOid] ?? [];
  if (checks.length === 0) {
    return fail(`no required checks reported on the '${found.head}' branch`);
  }
  print(
    checks.map((check) => ({
      ...check,
      state: CHECK_STATES[check.bucket],
      link: null,
    })),
  );
  if (
    checks.some((check) => check.bucket === "fail" || check.bucket === "cancel")
  ) {
    process.exitCode = CHECKS_FAILING;
  } else if (checks.some((check) => check.bucket === "pending")) {
    process.exitCode = CHECKS_PENDING;
  }
  return true;
}

function pr(world: World, args: readonly string[], login: string): boolean {
  if (args[0] !== "pr") {
    return false;
  }
  world.pulls ??= [];
  if (args[1] === "list") {
    const head = flagValue(args, "--head");
    const state = (flagValue(args, "--state") ?? "open").toUpperCase();
    print(
      world.pulls
        .filter((pull) => pull.head === head)
        .map(pullRow)
        .filter((row) => state === "ALL" || row.state === state),
    );
    return true;
  }
  if (args[1] === "view") {
    const found = world.pulls.find((pull) => String(pull.number) === args[2]);
    if (found === undefined) {
      return fail("gh: Could not resolve to a PullRequest");
    }
    print({ ...pullRow(found), isCrossRepository: false });
    return true;
  }
  if (args[1] === "checks" && args.includes("--required")) {
    return requiredChecks(world, args[2]);
  }
  if (args[1] === "create") {
    world.pulls.push({
      number: nextPull(world),
      head: flagValue(args, "--head") ?? "",
      base: flagValue(args, "--base") ?? "main",
      title: flagValue(args, "--title") ?? "",
      body: flagValue(args, "--body") ?? "",
      author: login,
      state: "OPEN",
      isDraft: false,
    });
    return true;
  }
  return fail(`fake gh: unsupported pr call ${args.join(" ")}`);
}

// Answers `args` when the call is one of the flow's. `changed` says the
// world must be written back.
function flowCall(
  world: World,
  args: readonly string[],
  login: string,
): { handled: boolean; changed: boolean } {
  if (pr(world, args, login)) {
    return { handled: true, changed: args[1] === "create" };
  }
  if (issueClose(world, args, login)) {
    return { handled: true, changed: true };
  }
  if (args[0] !== "api" || args[1] === "graphql" || args[1] === "--include") {
    return { handled: false, changed: false };
  }
  if (commentEdit(world, args)) {
    return { handled: true, changed: true };
  }
  if (args.includes("POST")) {
    return { handled: gitWrite(args), changed: false };
  }
  return {
    handled: paginated(world, args) || plainGet(world, args),
    changed: false,
  };
}

// Counts an open-issue control listing, and stops the buddy with SIGTERM
// at the world's `stopBuddy.atPoll`th: the first label's listing starts
// each poll.
function countPoll(world: World, target: string): boolean {
  const stop = world.stopBuddy;
  if (stop === undefined || !target.includes(START_LISTING)) {
    return false;
  }
  const query = target.slice(target.indexOf("?") + 1);
  const page = new URLSearchParams(query).get("page");
  if (page !== null && page !== "1") {
    return false;
  }
  stop.polls += 1;
  if (stop.polls === stop.atPoll) {
    process.kill(stop.pid, "SIGTERM");
  }
  return true;
}

export { countPoll, flowCall };
