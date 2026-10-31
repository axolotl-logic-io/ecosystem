// The standards assessment's wire format
// (docs/reference/standards-upgrade.md): what `standards-upgrade assess`
// writes as assessment.json, and the marker a plan carries into its upgrade
// issue. Every assessment is parsed with ASSESSMENT before it's written, so a
// reader can trust its shape.

import { z } from "zod";

// The maintained standard's version. A change to what any criterion checks
// gives a new version, so a plan bound to the old one goes stale.
const POLICY_VERSION = "standards-v2";

const SHA = z.string().regex(/^[0-9a-f]{40}$/u);
const REPO = z.string().regex(/^[\w.-]+\/[\w.-]+$/u);

// verified pass, evidenced failure, unverified or not applicable (#129).
const STATUS = z.enum(["passed", "failed", "unverified", "not-applicable"]);

const CRITERION = z.strictObject({
  id: z.string().min(1),
  status: STATUS,
  evidence: z.string().min(1),
});

const DISPOSITION = z.strictObject({
  kind: z.enum([
    "archived",
    "scaffold",
    "node-npm",
    "python-poetry",
    "unsupported",
  ]),
  detail: z.string().min(1),
  // The ecosystems or toolchains seen at the source commit.
  toolchains: z.array(z.string()),
});

const COMPONENT = z.strictObject({
  path: z.string(),
  name: z.string().nullable(),
  private: z.boolean(),
  lockfile: z.string().nullable(),
  scripts: z.array(z.string()),
  dependencies: z.number().int().nonnegative(),
  devDependencies: z.number().int().nonnegative(),
});

const WORKFLOW = z.strictObject({
  path: z.string(),
  triggers: z.array(z.string()),
  parsed: z.boolean(),
});

// One command run in the sandbox. Its output stays in OUT_DIR/logs, never in
// the assessment, report or plan: repository code wrote it.
const COMMAND = z.strictObject({
  argv: z.array(z.string()).min(1),
  network: z.boolean(),
  // null when it was killed at its time limit.
  exitCode: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative(),
  log: z.string().min(1),
});

const SANDBOX = z.strictObject({
  tool: z.literal("bwrap"),
  // null when there's no usable sandbox; `detail` says why.
  version: z.string().nullable(),
  detail: z.string().min(1),
  // The npm registry every fetch went to.
  registry: z.string().nullable(),
  npm: z.string().nullable(),
});

// What `assess` writes.
const ASSESSMENT = z.strictObject({
  version: z.literal(2),
  policy: z.literal(POLICY_VERSION),
  repo: REPO,
  requestedRef: z.string().nullable(),
  sourceRef: z.string().min(1),
  source: SHA,
  assessedAt: z.iso.datetime(),
  toolchain: z.strictObject({ node: z.string(), git: z.string() }),
  disposition: DISPOSITION,
  inventory: z.strictObject({
    files: z.number().int().nonnegative(),
    components: z.array(COMPONENT),
    workflows: z.array(WORKFLOW),
    // The base branch's required checks; null when they couldn't be read.
    requiredChecks: z.array(z.string()).nullable(),
  }),
  criteria: z.array(CRITERION),
  verdict: z.enum([
    "acceptable",
    "not-acceptable",
    "unverified",
    "archive-candidate",
    "no-action",
    "blocked",
  ]),
  // Changes the upgrade's Implementation makes, each for a criterion.
  proposed: z.array(
    z.strictObject({ criterion: z.string(), change: z.string() }),
  ),
  // What needs separate owner authority: settings, archival, access.
  ownerActions: z.array(z.string()),
  // null when the assessment ran statically (`--static`).
  sandbox: SANDBOX.nullable(),
  // Repository commands this assessment ran in its sandbox.
  commands: z.array(COMMAND),
});

// The tag that opens the marker a plan's upgrade issue carries:
// `<!-- standards-upgrade:plan {PLAN_MARKER JSON} -->`.
const PLAN_TAG = "standards-upgrade:plan";

// The marker a plan's upgrade issue carries, binding it to one assessment.
const PLAN_MARKER = z.strictObject({
  version: z.literal(1),
  repo: REPO,
  source: SHA,
  policy: z.string().min(1),
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
});

type Assessment = z.infer<typeof ASSESSMENT>;
type Command = z.infer<typeof COMMAND>;
type SandboxRecord = z.infer<typeof SANDBOX>;
type Criterion = z.infer<typeof CRITERION>;
type Component = z.infer<typeof COMPONENT>;
type Disposition = z.infer<typeof DISPOSITION>;
type Workflow = z.infer<typeof WORKFLOW>;
type PlanMarker = z.infer<typeof PLAN_MARKER>;

export type {
  Assessment,
  Command,
  Component,
  Criterion,
  Disposition,
  PlanMarker,
  SandboxRecord,
  Workflow,
};
export { ASSESSMENT, PLAN_MARKER, PLAN_TAG, POLICY_VERSION };
