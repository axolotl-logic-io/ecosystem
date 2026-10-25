// The prompt pages (src/job/prompts.ts): the Markdown pages in the
// pipeline's prompts/ folder, which install.ts installs in the root's
// prompts/, from which a stage job pins its sessions' behavioral prompts,
// one page per session as the reviewer-flow contract maps them. The pages
// the pipeline ships are valid prompt pages. The job pins only its stage's
// pages, byte for byte with each page's sha256, and keeps them though the
// folder changes. A missing, linked, empty, one-line or non-UTF-8 page, or a
// prompt folder that isn't a folder, fails the job before it runs an op or
// starts pi, for a run and a boundary print alike; so does the --brain-path
// flag an older job took. The job.json and usage records of an older job,
// which pinned its pages from a wiki clone and named the clone's HEAD, still
// parse.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import "../isolated-root-test-kit.ts";
import { AUTHOR_SESSION, READER_STAGE, repliesAt } from "../job-fixtures.ts";
import {
  HIPPY_PROMPT_PAGES,
  PROMPT_PAGES,
  pageTextOf,
  SYNC_PROMPT_PAGES,
} from "../prompt-test-kit.ts";
import { sessionRecord } from "../usage-fixtures.ts";
import type { OpsLine, Place } from "./job-test-kit.ts";
import {
  flagValue,
  logOf,
  piStarts,
  runJob,
  setUp,
  statusOf,
} from "./job-test-kit.ts";

const { isStage, STAGES }: typeof import("../../src/stages.ts") = await import(
  "../../src/stages.ts"
);
const { pinPrompts }: typeof import("../../src/job/prompts.ts") = await import(
  "../../src/job/prompts.ts"
);
const { openStatus, readStatus }: typeof import("../../src/job/status.ts") =
  await import("../../src/job/status.ts");
const {
  parseUsageLine,
  serializeUsage,
}: typeof import("../../src/job/usage-log.ts") = await import(
  "../../src/job/usage-log.ts"
);

// A usage request as ops.log keeps it: the usage record's line.
interface UsageRequest extends OpsLine {
  line: string;
}

// What a test reads of a usage record: its kind and its session's prompt.
interface UsageRecord {
  kind: string;
  prompt?: unknown;
}

// The prompt pages the pipeline ships, which install.ts installs.
const SHIPPED: string = new URL("../../prompts/", import.meta.url).pathname;
const AUTHOR_PAGE = "author.md";
const UNKNOWN_FLAG = /Unknown option '--brain-path'/u;
const NOT_A_FOLDER = /prompt folder .* isn't a folder/u;
const CANT_READ = /can't read prompt page .*author\.md/u;
const NOT_TEXT = /prompt page .*author\.md isn't a page of text/u;
const NOT_UTF8 = /prompt page .*author\.md isn't UTF-8/u;
const TOO_LONG = /prompt page .*author\.md is over 131071 bytes/u;
// The longest page pi can take as one argument.
const PAGE_MAX_BYTES = 131_071;
// The length of a SHA-1 commit id in hex, as an older job's wiki HEAD was.
const SHA1_HEX_LENGTH = 40;
// "#", a byte no UTF-8 text holds, and a newline.
const NOT_UTF8_BYTES = Buffer.from("23ff0a", "hex");

// A job whose claim would run the author, so a failure is the only reason
// it runs nothing.
function place(): Place {
  return setUp(repliesAt(READER_STAGE), AUTHOR_SESSION);
}

// Returns their sha256, hex
function sha256Of(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// How the job in `at` ended, `r`, and whether it ran an op or a pi.
// pattern: the failure its stderr should name
function failureOf(
  at: ReturnType<typeof place>,
  r: { status: number | null; stderr: string },
  pattern: RegExp,
): { status: number | null; named: boolean; ran: number } {
  const ran = logOf(at, "ops.log").length + logOf(at, "pi.log").length;
  return { status: r.status, named: pattern.test(r.stderr), ran };
}

const FAILED = { status: 1, named: true, ran: 0 };

test("the pipeline ships exactly the prompt pages, and every stage pins them as valid pages, whoever hardens", () => {
  const shipped = fs.readdirSync(SHIPPED).sort();
  const listed = [...PROMPT_PAGES, ...HIPPY_PROMPT_PAGES, ...SYNC_PROMPT_PAGES];
  const named = [...new Set(listed.map(({ page }) => page))].sort();
  assert.deepEqual(shipped, named);
  const buddies: {
    hardening: "lawd" | "hippy";
    differing: typeof HIPPY_PROMPT_PAGES;
  }[] = [
    { hardening: "lawd", differing: [] },
    { hardening: "hippy", differing: HIPPY_PROMPT_PAGES },
  ];
  for (const { hardening, differing } of buddies) {
    for (const stage of STAGES) {
      const { pinned } = pinPrompts(SHIPPED, stage, hardening);
      const pages = PROMPT_PAGES.filter((entry) => entry.stage === stage).map(
        (entry) =>
          differing.find(
            ({ stage: at, phase }) => at === stage && phase === entry.phase,
          ) ?? entry,
      );
      assert.deepEqual(
        pinned,
        pages.map(({ page }) => ({
          page,
          path: path.join(SHIPPED, page),
          sha256: sha256Of(fs.readFileSync(path.join(SHIPPED, page))),
          head: null,
        })),
        `${hardening} ${stage}`,
      );
    }
  }
  assert.deepEqual(
    pinPrompts(SHIPPED, "review").pinned,
    pinPrompts(SHIPPED, "review", "lawd").pinned,
    "a job given no Hardening buddy pins the installed Reviewer's page",
  );
  // A Sync task job pins only its resolver's page, at either stage it runs
  // at; Integration runs no session, so it pins none (#186).
  for (const { stage, page } of SYNC_PROMPT_PAGES) {
    assert.ok(isStage(stage), stage);
    const sync = pinPrompts(SHIPPED, stage, "lawd", "sync");
    assert.deepEqual(
      sync.pinned.map((pinned) => pinned.page),
      [page],
    );
  }
  assert.deepEqual(
    pinPrompts(SHIPPED, "merge", "lawd", "integration").pinned,
    [],
  );
});

test("a job pins only its stage's pages, byte for byte, and keeps them though the folder changes", () => {
  const at = place();
  const text = "\uFEFF# Security\r\n\r\nLook for what an attacker gets.  \n";
  const page = "security.md";
  fs.writeFileSync(path.join(at.prompts, page), text);
  const prompts = pinPrompts(at.prompts, "merge");
  fs.writeFileSync(path.join(at.prompts, page), "Changed.\nSince.\n");
  assert.equal(prompts.promptFor("merge", "security-review")?.text, text);
  assert.deepEqual(prompts.promptFor("merge", "security-review")?.provenance, {
    page,
    path: path.join(at.prompts, page),
    sha256: sha256Of(text),
    head: null,
  });
  assert.deepEqual(
    prompts.pinned.map((pinned) => pinned.page),
    [page],
  );
  assert.equal(prompts.promptFor("merge", null), null);
  assert.equal(prompts.promptFor("merge", "hardening"), null);
  assert.equal(prompts.promptFor("review", "hardening"), null);
});

test("a page holding a NUL or over 131071 bytes can't be pinned", () => {
  const at = place();
  const page = path.join(at.prompts, AUTHOR_PAGE);
  fs.writeFileSync(page, "# Author\n\0\n");
  assert.throws(() => pinPrompts(at.prompts, "author"), NOT_TEXT);
  fs.writeFileSync(page, `#\n${"a".repeat(PAGE_MAX_BYTES - 2)}`);
  assert.equal(pinPrompts(at.prompts, "author").pinned.length, 1);
  fs.writeFileSync(page, `#\n${"a".repeat(PAGE_MAX_BYTES - 1)}`);
  assert.throws(() => pinPrompts(at.prompts, "author"), TOO_LONG);
});

test("pinning from a prompt folder that doesn't exist throws and creates nothing", () => {
  const at = place();
  const missing = path.join(at.tmp, "not-installed", "prompts");
  assert.throws(() => pinPrompts(missing, "author"), NOT_A_FOLDER);
  assert.equal(fs.existsSync(path.dirname(missing)), false);
});

test("the author job's pi gets its page appended to its system prompt, and job.json and the usage record name where it came from", () => {
  const at = place();
  const r = runJob(at, ["--stage", READER_STAGE]);
  assert.equal(r.status, 0, r.stderr);
  const [start] = piStarts(at);
  assert.ok(start);
  const appended = flagValue(start.argv, "--append-system-prompt");
  assert.equal(appended, pageTextOf(AUTHOR_PAGE));
  const sha256 = sha256Of(pageTextOf(AUTHOR_PAGE));
  const status = statusOf(at);
  assert.deepEqual(status?.prompts, [
    {
      page: AUTHOR_PAGE,
      path: path.join(at.root, "prompts", AUTHOR_PAGE),
      sha256,
      head: null,
    },
  ]);
  const launched = status.launches.filter(({ kind }) => kind === "session");
  assert.deepEqual(
    launched.map(({ prompt }) => prompt),
    [{ page: AUTHOR_PAGE, sha256 }],
  );
  const usage = logOf<UsageRequest>(at, "ops.log").filter(
    ({ op }) => op === "usage",
  );
  const records = usage.map(({ line }): UsageRecord => JSON.parse(line));
  const session = records.find(({ kind }) => kind === "session");
  assert.deepEqual(session?.prompt, { page: AUTHOR_PAGE, sha256, head: null });
});

test("job.json and a usage record an older job wrote, naming its wiki clone's HEAD, still parse with it", () => {
  const at = place();
  const runDir = path.join(at.tmp, "old-run");
  const head = "a".repeat(SHA1_HEX_LENGTH);
  const page = "Pipeline-Prompt-Developer.md";
  const prompt = { page, sha256: sha256Of(pageTextOf(page)) };
  const pinned = { ...prompt, path: `/wiki/${page}` };
  openStatus(runDir, {
    id: "job-1",
    startedAt: "2026-10-15T10:00:00.000Z",
    issue: 7,
    stage: "implement",
    lane: null,
    socket: "",
    prompts: [{ ...pinned, head: null }],
  });
  const file = path.join(runDir, "job.json");
  const old = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(
    file,
    JSON.stringify({ ...old, prompts: [{ ...pinned, head }] }),
  );
  assert.deepEqual(readStatus(runDir)?.prompts, [{ ...pinned, head }]);
  const line = serializeUsage(sessionRecord({ prompt: { ...prompt, head } }));
  const record = parseUsageLine(line);
  assert.ok(record?.kind === "session");
  assert.deepEqual(record.prompt, { ...prompt, head });
});

test("a run or a boundary print given --brain-path, or whose root has no prompt folder, fails before anything runs", () => {
  const at = place();
  for (const extra of [[], ["--print-boundary"]]) {
    const args = ["--stage", READER_STAGE, ...extra];
    const flagged = runJob(at, [...args, "--brain-path", at.prompts]);
    assert.deepEqual(failureOf(at, flagged, UNKNOWN_FLAG), FAILED);
  }
  fs.rmSync(at.prompts, { recursive: true });
  const missing = runJob(at, ["--stage", READER_STAGE]);
  assert.deepEqual(failureOf(at, missing, NOT_A_FOLDER), FAILED);
});

test("missing, linked, blank, single-line and non-UTF-8 prompt pages cannot be pinned", () => {
  const at = place();
  const page = path.join(at.prompts, AUTHOR_PAGE);
  const outside = path.join(at.tmp, "outside.md");
  fs.writeFileSync(outside, pageTextOf(AUTHOR_PAGE));
  // Each case starts with the page gone, so the first leaves it missing.
  const broken: [() => void, RegExp][] = [
    [(): undefined => undefined, CANT_READ],
    [(): void => fs.symlinkSync(outside, page), CANT_READ],
    [(): void => fs.writeFileSync(page, " \n\n"), NOT_TEXT],
    [(): void => fs.writeFileSync(page, "One line only."), NOT_TEXT],
    [(): void => fs.writeFileSync(page, NOT_UTF8_BYTES), NOT_UTF8],
  ];
  for (const [breakPage, pattern] of broken) {
    fs.rmSync(page, { force: true });
    breakPage();
    assert.throws(() => pinPrompts(at.prompts, READER_STAGE), pattern);
  }
});

test("a missing prompt page refuses both job modes before any op or model", () => {
  const at = place();
  fs.rmSync(path.join(at.prompts, AUTHOR_PAGE));
  for (const extra of [[], ["--print-boundary"]]) {
    const r = runJob(at, ["--stage", READER_STAGE, ...extra]);
    assert.deepEqual(failureOf(at, r, CANT_READ), FAILED, r.stderr);
  }
});
