// @ts-check
// Protocol compatibility is checked against the exact pinned bytes before a
// Merge job claims, synchronizes or launches any resolver, not from prose.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { pageTextOf } from "./brain-test-kit.mjs";
import { AUTHOR_SESSION, READER_STAGE, repliesAt } from "./job-fixtures.mjs";
import { logOf, runJob, setUp } from "./job-test-kit.mjs";

const { openBrain } = await import("../src/job/brain.ts");
const { CODE_RESOLVER_PROTOCOL } = await import(
  "../src/code-resolver-contract.ts"
);
const PAGE = "Pipeline-Prompt-Integration.md";
const REQUIRED = "Code-Resolver-Protocol: stage-text-and-return/v1";
const MISSING_DECLARATION = /missing Code-Resolver-Protocol declaration/u;
const LEGACY = `# Reviewer integration

Resolve each stopped commit and continue the code rebase until finished.
Reply cannot-fix when the whole rebase is not finished.
`;
const CASES = [
  { name: "legacy continue-until-finished", text: LEGACY, found: "missing" },
  {
    name: "older incompatible version",
    text: `${LEGACY}\nCode-Resolver-Protocol: stage-text-and-return/v0\n`,
    found: "stage-text-and-return/v0",
  },
  {
    name: "unknown version",
    text: `${LEGACY}\nCode-Resolver-Protocol: stage-text-and-return/v999\n`,
    found: "stage-text-and-return/v999",
  },
  {
    name: "different protocol",
    text: `${LEGACY}\nCode-Resolver-Protocol: continue-until-finished/v1\n`,
    found: "continue-until-finished/v1",
  },
  {
    name: "duplicate declarations",
    text: `${REQUIRED}\n${REQUIRED}\n`,
    found: "ambiguous",
  },
  {
    name: "conflicting declarations",
    text: `${REQUIRED}\nCode-Resolver-Protocol: unknown/v1\n`,
    found: "unknown/v1",
  },
  {
    name: "empty declaration",
    text: "# Integration\nCode-Resolver-Protocol:\n",
    found: "unsupported",
  },
];

for (const scenario of CASES) {
  test(`${scenario.name} refuses Merge before any op or session, preserving existing recovery and counts`, () => {
    const at = setUp(repliesAt(READER_STAGE), AUTHOR_SESSION);
    const page = path.join(at.brain, PAGE);
    fs.writeFileSync(page, scenario.text);
    fs.mkdirSync(at.runDir, { recursive: true });
    const recovery = path.join(at.runDir, "retained-recovery.txt");
    fs.writeFileSync(
      recovery,
      "retained checkout and synchronization context\n",
    );
    const stateFile = path.join(at.root, "replies.json");
    const state = fs.readFileSync(stateFile);
    const r = runJob(at, ["--stage", "merge"]);
    assert.equal(r.status, 1, r.stderr);
    const sha256 = createHash("sha256").update(scenario.text).digest("hex");
    for (const fact of [
      PAGE,
      page,
      sha256,
      "wiki HEAD unavailable",
      "incompatible code-resolver contract",
      REQUIRED,
      scenario.found,
      "compatible published Integration page",
      "--brain-path",
      "explicitly authorize a new Merge run",
      "installation does not refresh the brain",
      "Do not bypass cannot-fix rejection",
    ]) {
      assert.ok(r.stderr.includes(fact), r.stderr);
    }
    assert.deepEqual(logOf(at, "ops.log"), []);
    assert.deepEqual(logOf(at, "pi.log"), []);
    assert.deepEqual(fs.readFileSync(stateFile), state);
    assert.equal(fs.readFileSync(page, "utf8"), scenario.text);
    assert.equal(
      fs.readFileSync(recovery, "utf8"),
      "retained checkout and synchronization context\n",
    );
  });
}

test("a compatible declaration is required even with corrected prose; it is not required for other stages", () => {
  const at = setUp(repliesAt(READER_STAGE), AUTHOR_SESSION);
  const page = path.join(at.brain, PAGE);
  fs.writeFileSync(
    page,
    "# Integration\nStage only assigned text and return.\n",
  );
  assert.throws(() => openBrain(at.brain, "merge"), {
    message: MISSING_DECLARATION,
  });
  assert.equal(openBrain(at.brain, "implement").pinned.length, 1);
});

test("brain selection changes only a newly pinned Merge job, without rewriting old pins or authorizing execution", () => {
  const at = setUp(repliesAt(READER_STAGE), AUTHOR_SESSION);
  const page = path.join(at.brain, PAGE);
  const original = pageTextOf(PAGE);
  const first = openBrain(at.brain, "merge");
  const pinned = first.promptFor("merge", "integration");
  assert.ok(pinned);
  assert.ok(
    pinned.text.includes(`Code-Resolver-Protocol: ${CODE_RESOLVER_PROTOCOL}`),
  );
  const provenance = { ...pinned.provenance };
  fs.writeFileSync(page, LEGACY);
  assert.throws(() => openBrain(at.brain, "merge"));
  assert.equal(first.promptFor("merge", "integration")?.text, original);
  assert.deepEqual(
    first.promptFor("merge", "integration")?.provenance,
    provenance,
  );
  const refreshed = `${original}\nSelected compatible published revision.\n`;
  fs.writeFileSync(page, refreshed);
  const next = openBrain(at.brain, "merge").promptFor("merge", "integration");
  assert.equal(next?.text, refreshed);
  assert.notEqual(next?.provenance.sha256, provenance.sha256);
  assert.equal(pinned.text, original);
  assert.deepEqual(pinned.provenance, provenance);
  assert.deepEqual(logOf(at, "ops.log"), []);
  assert.deepEqual(logOf(at, "pi.log"), []);
});
