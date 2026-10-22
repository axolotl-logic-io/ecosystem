// @ts-check
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { CONFIG, fakeGh, root } from "./ops-cli-test-kit.mjs";

const { loadConfig, paths } = await import("../src/config.ts");
const { executionIdentity, issueExecution, withExecution } = await import(
  "../src/execution.ts"
);
const { claimExecutionState, readExecutionClaimState, saveExecutionState } =
  await import("../src/execution-state.ts");
const { ghIsRead } = await import("../src/github.ts");
const SHA_WIDTH = 40;
const TRANSPORT = z.looseObject({
  comments: z.array(
    z.looseObject({
      id: z.number(),
      issue: z.number(),
      body: z.string(),
      user: z.object({ login: z.string() }),
      lastEditedAt: z.string().nullable(),
      editor: z.object({ login: z.string() }).nullable(),
      graphBody: z.string().optional(),
      graphAuthor: z.object({ login: z.string() }).optional(),
    }),
  ),
  refs: z.record(z.string(), z.string()),
  failState: z.boolean().optional(),
  loseStateResponse: z.boolean().optional(),
});

/** @param {number} issue */
function executionFixture(issue) {
  const plain = loadConfig(CONFIG);
  const cfg = withExecution(plain, executionIdentity(plain, issue, "stable"));
  const base = "b".repeat(SHA_WIDTH);
  fakeGh.reply([{ when: "pr list", keep: true, stdout: "[]" }]);
  fakeGh.transport({
    repo: cfg.repo,
    token: 100,
    seq: 1000,
    refs: { [`heads/${cfg.baseBranch}`]: base },
    commits: { [base]: { sha: base, tree: { sha: "c".repeat(SHA_WIDTH) } } },
    comments: [],
  });
  return {
    cfg,
    issue,
    claim: () => claimExecutionState(cfg, issue),
    read: () => readExecutionClaimState(cfg, issue),
    save: /** @param {import('../src/state.ts').IssueState} state */ (state) =>
      saveExecutionState(cfg, issue, state),
    guard: () => issueExecution(cfg, issue),
    next: () => withExecution(plain, executionIdentity(plain, issue, "stable")),
    journal: path.join(paths.runDir(cfg, issue), "coordination-uncertain.json"),
    transport: () => TRANSPORT.parse(fakeGh.transportState()),
    update: /** @param {(state: z.infer<typeof TRANSPORT>) => void} change */ (
      change,
    ) => {
      const state = TRANSPORT.parse(fakeGh.transportState());
      change(state);
      fakeGh.transport(state);
    },
    writes: () => fakeGh.writes(ghIsRead),
    calls: () => fakeGh.authenticatedCalls(),
    setup: () =>
      fs.writeFileSync(path.join(root, `setup-${issue}`), "confirmed"),
    setupExists: () => fs.existsSync(path.join(root, `setup-${issue}`)),
  };
}

export { executionFixture };
