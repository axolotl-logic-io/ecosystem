// The parts of gh that the buddy flow tests' runtime, tasks and ops use
// beyond the signal reads fake-gh.ts answers: whole paginated comment
// listings (`--paginate --jq '.[] | @json'`), comment edits, plain resource
// reads (issues, collaborators), the repository's git database, which is
// the real local bare origin in FAKE_GH_ORIGIN, and `gh pr` for the item's
// pull request: its view, checks, creation, draft and ready changes, merge
// commit, submitted reviews and thread replies. flowCall answers from the
// world and says whether the call was one of these.
import { spawnSync } from "node:child_process";
import process from "node:process";
import { z } from "zod";
import { wire } from "../../../src/discovery/wire.ts";
import {
  fail,
  origin,
  printError,
  print as printOut,
  setStatus,
  stdin,
} from "./fake-gh-call.ts";
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
const PULL_REVIEWS = /^repos\/[^/]+\/[^/]+\/pulls\/(?<number>\d+)\/reviews$/u;
const PULL_REPLY =
  /^repos\/[^/]+\/[^/]+\/pulls\/(?<number>\d+)\/comments\/(?<id>\d+)\/replies$/u;
const CLOSES =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(?<number>\d+)\b/giu;
const REVIEW_INPUT = wire(
  z.object({
    commitId: z.string(),
    event: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]),
    body: z.string().optional(),
    comments: z
      .array(
        z.object({
          path: z.string(),
          line: z.number().int().positive(),
          body: z.string(),
        }),
      )
      .optional(),
  }),
);
const REVIEW_STATES: ReadonlyMap<
  z.infer<typeof REVIEW_INPUT>["event"],
  NonNullable<Pull["reviews"]>[number]["state"]
> = new Map([
  ["APPROVE", "APPROVED"],
  ["REQUEST_CHANGES", "CHANGES_REQUESTED"],
  ["COMMENT", "COMMENTED"],
] as const);
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

function print(value: unknown): void {
  printOut(`${JSON.stringify(value)}\n`);
}

function repositoryOrigin(): string {
  return origin() ?? fail("fake gh: FAKE_GH_ORIGIN is not set");
}

function git(args: string[]): { ok: boolean; out: string } {
  const run = spawnSync("git", ["-C", repositoryOrigin(), ...args], {
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
  mergeable: NonNullable<Pull["mergeable"]>;
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
    if (
      origin() === undefined &&
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
  const input: unknown = JSON.parse(stdin());
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

// Whether the origin can merge the PR's head into its base: what GitHub
// reports as its `mergeable`, unless the world overrides it.
function mergeableOf(pull: Pull, head: string): PullRow["mergeable"] {
  if (pull.mergeable !== undefined) {
    return pull.mergeable;
  }
  if (head === "") {
    return "UNKNOWN";
  }
  const merged = spawnSync(
    "git",
    [
      "-C",
      repositoryOrigin(),
      "merge-tree",
      "--write-tree",
      `refs/heads/${pull.base}`,
      head,
    ],
    { encoding: "utf8" },
  );
  if (merged.status === 0) {
    return "MERGEABLE";
  }
  if (merged.status === 1) {
    return "CONFLICTING";
  }
  return "UNKNOWN";
}

// The PR as GitHub shows it from the origin's refs: an open PR whose head
// commit is on its base branch, as a fast-forward push of the base puts it,
// reads merged, with that head as its merge commit; a PR `gh pr merge`
// merged reads merged with its own merge commit.
function pullRow(pull: Pull): PullRow {
  const head = git(["rev-parse", `refs/heads/${pull.head}`]).out;
  let { state } = pull;
  let mergeCommit: PullRow["mergeCommit"] = null;
  if (pull.mergeCommit !== undefined) {
    state = "MERGED";
    mergeCommit = { oid: pull.mergeCommit };
  } else if (
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
    mergeable: mergeableOf(pull, head),
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

function checkReply(world: World): World["checksReply"] {
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
    return reply;
  }
  return world.checksSequence?.shift();
}

// The required checks on PR `number`'s head as the origin has it, as
// `gh pr checks --required --json` prints them and exits.
function requiredChecks(world: World, number: string | undefined): boolean {
  const found = (world.pulls ?? []).find(
    (pull) => String(pull.number) === number,
  );
  if (found === undefined) {
    return fail("gh: Could not resolve to a PullRequest");
  }
  const reply = checkReply(world);
  if (reply !== undefined) {
    if (
      reply.moveHeadTo !== undefined &&
      !git(["update-ref", `refs/heads/${found.head}`, reply.moveHeadTo]).ok
    ) {
      return fail("fake gh: could not move the PR head during its CI read");
    }
    printOut(reply.stdout);
    printError(reply.stderr);
    setStatus(reply.code);
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
    setStatus(CHECKS_FAILING);
  } else if (checks.some((check) => check.bucket === "pending")) {
    setStatus(CHECKS_PENDING);
  }
  return true;
}

// Closes each open issue the merged PR's body names with a closing keyword,
// as GitHub does when a PR merges into the default branch.
function closeLinked(world: World, pull: Pull, login: string): void {
  for (const match of pull.body.matchAll(CLOSES)) {
    const { number } = match.groups ?? {};
    const issue = world.issues.find((item) => String(item.number) === number);
    if (issue !== undefined && issue.closed === undefined) {
      issue.closed = { by: login, reason: "completed" };
      issue.events.push({
        id: world.nextId,
        event: "closed",
        label: null,
        actor: login,
        viaApp: false,
        createdAt: postedAt(world.nextId),
      });
      world.nextId += 1;
    }
  }
}

// `gh pr merge N --merge --match-head-commit SHA`: a merge commit of the
// head into the base, made in the origin, only while the PR is open, not a
// draft, still at SHA, free of conflicts and, when the world requires it,
// containing its base.
function merge(
  world: World,
  args: readonly string[],
  login: string,
  found: Pull,
): boolean {
  const row = pullRow(found);
  const expected = flagValue(args, "--match-head-commit");
  if (!args.includes("--merge") || expected === undefined) {
    return fail("fake gh: a merge must be --merge --match-head-commit");
  }
  if (row.state !== "OPEN") {
    return fail(`GraphQL: Pull request #${found.number} is not open`);
  }
  if (row.isDraft) {
    return fail(`GraphQL: Pull request #${found.number} is still a draft`);
  }
  if (row.headRefOid !== expected) {
    return fail(
      "GraphQL: Head branch was modified. Review and try the merge again.",
    );
  }
  if (row.mergeable !== "MERGEABLE") {
    return fail(`GraphQL: Pull request #${found.number} is not mergeable`);
  }
  const base = `refs/heads/${found.base}`;
  if (
    world.requireUpToDate === true &&
    !git(["merge-base", "--is-ancestor", base, row.headRefOid]).ok
  ) {
    return fail("GraphQL: Head branch is out of date with the base branch");
  }
  const before = git(["rev-parse", base]).out;
  const tree = git(["merge-tree", "--write-tree", base, row.headRefOid]).out;
  const made = git([
    "commit-tree",
    tree,
    "-p",
    before,
    "-p",
    row.headRefOid,
    "-m",
    `Merge pull request #${found.number} from ${found.head}`,
  ]);
  if (!(made.ok && git(["update-ref", base, made.out, before]).ok)) {
    return fail("fake gh: the merge commit could not be made");
  }
  found.state = "MERGED";
  found.mergeCommit = made.out;
  closeLinked(world, found, login);
  return true;
}

// `gh pr ready N` marks the PR ready for review; `--undo` makes it a draft.
function ready(args: readonly string[], found: Pull): boolean {
  if (pullRow(found).state !== "OPEN") {
    return fail(`GraphQL: Pull request #${found.number} is not open`);
  }
  found.isDraft = args.includes("--undo");
  return true;
}

function pullNamed(world: World, number: string | undefined): Pull {
  const found = (world.pulls ?? []).find(
    (pull) => String(pull.number) === number,
  );
  if (found === undefined) {
    return fail("gh: Could not resolve to a PullRequest");
  }
  return found;
}

// A review submitted by `login` through `--input`: its line comments start
// threads in it. GitHub refuses a PR's author approving or requesting
// changes on their own PR.
function submitReview(
  world: World,
  login: string,
  found: Pull,
  args: readonly string[],
): boolean {
  if (!args.includes("--input")) {
    return fail("fake gh: a review is submitted with --input");
  }
  const input = REVIEW_INPUT.parse(JSON.parse(stdin()));
  const state = REVIEW_STATES.get(input.event) ?? "COMMENTED";
  if (state !== "COMMENTED" && found.author === login) {
    return fail(
      "gh: Unprocessable Entity (HTTP 422): Can not approve or request changes on your own pull request",
    );
  }
  const id = world.nextId;
  world.nextId += 1;
  found.reviews ??= [];
  found.reviews.push({
    id,
    author: login,
    state,
    commitId: input.commitId,
    body: input.body ?? "",
    submittedAt: postedAt(id),
  });
  found.reviewComments ??= [];
  for (const comment of input.comments ?? []) {
    found.reviewComments.push({
      id: world.nextId,
      review: id,
      inReplyTo: null,
      author: login,
      path: comment.path,
      line: comment.line,
      commitId: input.commitId,
      body: comment.body,
      createdAt: postedAt(world.nextId),
    });
    world.nextId += 1;
  }
  print(
    Object.fromEntries([
      ["id", id],
      ["state", state],
      ["commit_id", input.commitId],
    ]),
  );
  return true;
}

// A reply by `login` in the thread of review comment `id`.
function threadReply(
  world: World,
  login: string,
  found: Pull,
  call: { args: readonly string[]; id: string },
): boolean {
  const { args, id } = call;
  const answered = (found.reviewComments ?? []).find(
    (comment) => String(comment.id) === id,
  );
  const field = args.find((arg) => BODY.test(arg)) ?? "";
  const { body } = BODY.exec(field)?.groups ?? {};
  if (answered === undefined || body === undefined) {
    return fail("gh: Not Found (HTTP 404)");
  }
  found.reviewComments ??= [];
  found.reviewComments.push({
    ...answered,
    id: world.nextId,
    review: null,
    inReplyTo: answered.inReplyTo ?? answered.id,
    author: login,
    body,
    createdAt: postedAt(world.nextId),
  });
  world.nextId += 1;
  return true;
}

// The PR writes through `gh api`: a submitted review and a thread reply.
function pullWrite(
  world: World,
  args: readonly string[],
  login: string,
): boolean {
  const endpoint = endpointOf(args);
  const { number: reviewed } = PULL_REVIEWS.exec(endpoint)?.groups ?? {};
  if (reviewed !== undefined) {
    return submitReview(world, login, pullNamed(world, reviewed), args);
  }
  const { number, id } = PULL_REPLY.exec(endpoint)?.groups ?? {};
  if (number !== undefined && id !== undefined) {
    return threadReply(world, login, pullNamed(world, number), { args, id });
  }
  return false;
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
  if (args[1] === "merge") {
    return merge(world, args, login, pullNamed(world, args[2]));
  }
  if (args[1] === "ready") {
    return ready(args, pullNamed(world, args[2]));
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
  const queued = world.checksSequence?.length ?? 0;
  if (pr(world, args, login)) {
    return {
      handled: true,
      changed:
        ["create", "merge", "ready"].includes(args[1] ?? "") ||
        (world.checksSequence?.length ?? 0) !== queued,
    };
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
  if (args.includes("POST") && pullWrite(world, args, login)) {
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
