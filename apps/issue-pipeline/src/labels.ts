// The pipeline's labels on GitHub: the status labels below and the stop labels
// (stops.ts). The issue pipeline's docs/reference/ describe every one of them.

import { z } from "zod";
import type { Config } from "./config.ts";
import { gh, ghJson } from "./github.ts";
import { OpsError } from "./ops-error.ts";
import type { GitHubLabel } from "./stops.ts";
import { isStopLabel, STOPS } from "./stops.ts";

interface StatusLabels {
  working: GitHubLabel;
  needsInfo: GitHubLabel;
  split: GitHubLabel;
  landed: GitHubLabel;
}

const LABELS: Readonly<StatusLabels> = {
  working: {
    name: "agent:working",
    color: "1d76db",
    description: "The agent pipeline is working on this",
  },
  needsInfo: {
    name: "agent:needs-info",
    color: "fbca04",
    description: "The agent pipeline asked a question",
  },
  split: {
    name: "agent:split",
    color: "c5def5",
    description: "Split into agent sub-issues",
  },
  landed: {
    name: "agent:landed",
    color: "0e8a16",
    description: "Landed by the agent pipeline",
  },
};

// The landed label before #166, which issues landed earlier still carry. It
// counts as landed and as the pipeline's, but is never applied or created.
const OLD_LANDED_LABEL = "agent:merged";

const PIPELINE_LABELS: readonly string[] = [
  ...Object.values(LABELS).map((label: GitHubLabel) => label.name),
  OLD_LANDED_LABEL,
];

// Whether label `name` marks an issue as landed: the landed label, or its
// name before #166.
function isLandedLabel(name: string): boolean {
  return name === LABELS.landed.name || name === OLD_LANDED_LABEL;
}

// GitHub's label list, as `gh label list --json name` and the labels API give it.
const LABEL_NAMES = z.array(z.looseObject({ name: z.string() })).nullable();

function isPipelineLabel(name: string): boolean {
  return PIPELINE_LABELS.includes(name) || isStopLabel(name);
}

function labelNames(listed: unknown): string[] {
  return (LABEL_NAMES.parse(listed) ?? []).map((label) => label.name);
}

// Creates any of the pipeline's labels the repo doesn't have yet.
function ensureLabels(cfg: Config): void {
  const existing = new Set(
    labelNames(
      ghJson(cfg, "landing", [
        "label",
        "list",
        "-R",
        cfg.repo,
        "--limit",
        "500",
        "--json",
        "name",
      ]),
    ),
  );
  const wanted = [...Object.values(LABELS), ...STOPS.map((stop) => stop.label)];
  for (const label of wanted) {
    if (!existing.has(label.name)) {
      gh(
        cfg,
        "landing",
        [
          "label",
          "create",
          label.name,
          "-R",
          cfg.repo,
          "--color",
          label.color,
          "--description",
          label.description,
        ],
        { allowFail: true },
      );
    }
  }
}

function setLabels(
  cfg: Config,
  number: number,
  add: readonly string[] = [],
  remove: readonly string[] = [],
): void {
  const endpoint = `repos/${cfg.repo}/issues/${number}/labels`;
  for (const name of remove) {
    gh(
      cfg,
      "landing",
      [
        "api",
        "-X",
        "DELETE",
        `${endpoint}/${encodeURIComponent(name)}`,
        "--silent",
      ],
      { allowFail: true },
    );
  }
  if (add.length > 0) {
    const fields = add.flatMap((name) => ["-f", `labels[]=${name}`]);
    gh(cfg, "landing", ["api", "-X", "POST", endpoint, "--silent", ...fields]);
  }
}

// Removes every stop label from an issue or PR, reading its labels if not given.
function clearStopLabels(
  cfg: Config,
  number: number,
  names?: readonly string[],
): void {
  const have =
    names ??
    labelNames(
      ghJson(cfg, "landing", [
        "api",
        `repos/${cfg.repo}/issues/${number}/labels`,
      ]),
    );
  setLabels(cfg, number, [], have.filter(isStopLabel));
}

// Stop cleanup is required, unlike best-effort ordinary label removal. A
// missing label is already removed; any other failed write stays unresolved.
const LABEL_ABSENT = /HTTP 404\b/iu;
function applyStopLabel(
  cfg: Config,
  number: number,
  label: string,
  workingRemoved: () => void,
): void {
  const endpoint = `repos/${cfg.repo}/issues/${number}/labels`;
  const have = labelNames(ghJson(cfg, "landing", ["api", endpoint]));
  for (const name of new Set([
    ...have.filter(isStopLabel),
    LABELS.working.name,
  ])) {
    const result = gh(
      cfg,
      "landing",
      [
        "api",
        "-X",
        "DELETE",
        `${endpoint}/${encodeURIComponent(name)}`,
        "--silent",
      ],
      { allowFail: true },
    );
    if (result.code !== 0 && !LABEL_ABSENT.test(result.stderr)) {
      throw new OpsError(
        `stop label removal failed for #${number} (${name}); gh exit status ${result.code}: ${result.stderr}`,
      );
    }
  }
  workingRemoved();
  setLabels(cfg, number, [label]);
}

export {
  applyStopLabel,
  clearStopLabels,
  ensureLabels,
  isLandedLabel,
  isPipelineLabel,
  LABELS,
  PIPELINE_LABELS,
  setLabels,
};
