import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Config } from "../src/config.ts";
import type { IssueState } from "../src/state.ts";
import type { GhReply } from "./fake-gh.ts";
import { CONFIG, fakeGh, root } from "./ops-cli-test-kit.ts";

interface ExecutionOptions {
  config?: string;
  replies?: readonly GhReply[];
}

const { loadConfig, paths }: typeof import("../src/config.ts") = await import(
  "../src/config.ts"
);
const {
  executionBinding,
  issueExecution,
  withExecution,
}: typeof import("../src/execution.ts") = await import("../src/execution.ts");
const {
  claimExecutionState,
  readExecutionClaimState,
  saveExecutionState,
}: typeof import("../src/execution-state.ts") = await import(
  "../src/execution-state.ts"
);
const { ghIsRead }: typeof import("../src/github.ts") = await import(
  "../src/github.ts"
);
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
  stateAfterConfirm: z.string().optional(),
  stateReadback: z
    .object({
      graphBody: z.string().optional(),
      graphAuthor: z.object({ login: z.string() }).optional(),
      lastEditedAt: z.string().optional(),
      editor: z.object({ login: z.string() }).optional(),
    })
    .optional(),
});

type Transport = z.infer<typeof TRANSPORT>;

// An issue's execution under a stable lane's binding, with the fake gh's
// transport behind it.
interface ExecutionFixture {
  cfg: Config;
  issue: number;
  claim: () => ReturnType<typeof claimExecutionState>;
  read: (bound?: Config) => ReturnType<typeof readExecutionClaimState>;
  save: (state: IssueState) => ReturnType<typeof saveExecutionState>;
  guard: () => ReturnType<typeof issueExecution>;
  next: (lane?: string) => Config;
  journal: string;
  transport: () => Transport;
  update: (change: (state: Transport) => void) => void;
  writes: () => string[][];
  calls: () => { identity: "dev" | "merge"; args: string[] }[];
  setup: () => void;
  setupExists: () => boolean;
}

function executionFixture(
  issue: number,
  options: ExecutionOptions = {},
): ExecutionFixture {
  const plain = loadConfig(options.config ?? CONFIG);
  const cfg = withExecution(plain, executionBinding(plain, issue, "stable"));
  const base = "b".repeat(SHA_WIDTH);
  fakeGh.reply([
    ...(options.replies ?? []),
    { when: "pr list", keep: true, stdout: "[]" },
  ]);
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
    claim: (): ReturnType<typeof claimExecutionState> =>
      claimExecutionState(cfg, issue),
    read: (bound: Config = cfg): ReturnType<typeof readExecutionClaimState> =>
      readExecutionClaimState(bound, issue),
    save: (state: IssueState): ReturnType<typeof saveExecutionState> =>
      saveExecutionState(cfg, issue, state),
    guard: (): ReturnType<typeof issueExecution> => issueExecution(cfg, issue),
    next: (lane = "stable"): Config =>
      withExecution(plain, executionBinding(plain, issue, lane)),
    journal: path.join(paths.runDir(cfg, issue), "coordination-uncertain.json"),
    transport: (): Transport => TRANSPORT.parse(fakeGh.transportState()),
    update: (change: (state: Transport) => void): void => {
      const state = TRANSPORT.parse(fakeGh.transportState());
      change(state);
      fakeGh.transport(state);
    },
    writes: (): string[][] => fakeGh.writes(ghIsRead),
    calls: (): { identity: "dev" | "merge"; args: string[] }[] =>
      fakeGh.authenticatedCalls(),
    setup: (): void =>
      fs.writeFileSync(path.join(root, `setup-${issue}`), "confirmed"),
    setupExists: (): boolean =>
      fs.existsSync(path.join(root, `setup-${issue}`)),
  };
}

export type { ExecutionFixture, Transport };
export { executionFixture };
