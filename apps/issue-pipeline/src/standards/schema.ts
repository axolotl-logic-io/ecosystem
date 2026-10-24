// The standards assessment's wire format (docs/reference/standards-upgrade.md):
// what `standards-upgrade assess` writes as assessment.json, and the marker a
// plan carries into its upgrade issue. Every assessment is parsed with
// ASSESSMENT before it's written, so a reader can trust its shape.

import { z } from "zod";

// The maintained standard's version. A change to what any criterion checks
// gives a new version, so a plan bound to the old one goes stale.
const POLICY_VERSION = "standards-v1";

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
  kind: z.enum(["archived", "scaffold", "node-npm", "unsupported"]),
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

const ASSESSMENT = z.strictObject({
  version: z.literal(1),
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
  // Repository commands this assessment ran. It runs none (no sandbox).
  commands: z.array(z.never()),
});

// The marker a plan's upgrade issue carries, binding it to one assessment.
const PLAN_MARKER = z.strictObject({
  version: z.literal(1),
  repo: REPO,
  source: SHA,
  policy: z.string().min(1),
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
});

type Assessment = z.infer<typeof ASSESSMENT>;
type Criterion = z.infer<typeof CRITERION>;
type Component = z.infer<typeof COMPONENT>;
type Disposition = z.infer<typeof DISPOSITION>;
type Workflow = z.infer<typeof WORKFLOW>;
type PlanMarker = z.infer<typeof PLAN_MARKER>;

export type {
  Assessment,
  Component,
  Criterion,
  Disposition,
  PlanMarker,
  Workflow,
};
export { ASSESSMENT, PLAN_MARKER, POLICY_VERSION };
