// The control-label sensor: which open issues carry a control label, and
// which application event explains a label an issue carries now. A label is a
// condition: the latest `labeled` event for it, with no later `unlabeled`
// event, explains it. Removing a label is never a signal, and a label
// nobody's event explains is contradictory evidence. The labels go on the
// issue; pull requests' labels grant nothing.
import { z } from "zod";
import type { Config } from "../config.ts";
import { wire } from "../discovery/wire.ts";
import type { StartTask } from "../domain.ts";
import { type Observation, observeAll, observeOne } from "./github-source.ts";
import type { EventActor } from "./qualification.ts";

const CONTROL_LABELS = [
  "start:implement",
  "start:verify",
  "start:fix",
  "start:land",
  "agents:stop",
] as const;
type ControlLabel = (typeof CONTROL_LABELS)[number];

// The task each start label requests; agents:stop requests none.
const START_LABELS: ReadonlyMap<ControlLabel, StartTask> = new Map<
  ControlLabel,
  StartTask
>([
  ["start:implement", "implement"],
  ["start:verify", "verify"],
  ["start:fix", "fix"],
  ["start:land", "land"],
]);

// The event that explains a present label.
interface LabelEvent {
  id: number;
  nodeId: string;
  createdAt: string;
  actor: EventActor | null;
}

// What explains each control label an issue carries now: its event, or
// null when the events contradict the label.
type LabelEvidence = ReadonlyMap<ControlLabel, LabelEvent | null>;

const POSITIVE = z.number().int().positive();
const LISTED_ISSUE = wire(
  z.looseObject({ number: POSITIVE, pullRequest: z.unknown().optional() }),
);
const ISSUE = wire(
  z.looseObject({
    number: POSITIVE,
    labels: z.array(z.union([z.string(), z.looseObject({ name: z.string() })])),
    pullRequest: z.unknown().optional(),
  }),
);
const EVENT = wire(z.looseObject({ id: POSITIVE, event: z.string() }));
const LABEL_EVENT = wire(
  z.looseObject({
    id: POSITIVE,
    nodeId: z.string().min(1),
    event: z.enum(["labeled", "unlabeled"]),
    createdAt: z.iso.datetime(),
    actor: z
      .looseObject({ login: z.string(), id: POSITIVE, type: z.string() })
      .nullable(),
    label: z.looseObject({ name: z.string() }),
    performedViaGithubApp: z.looseObject({}).nullable(),
  }),
);

type ParsedLabelEvent = z.infer<typeof LABEL_EVENT>;

const CONTROL_LABEL = z.enum(CONTROL_LABELS);

function isControlLabel(name: string): name is ControlLabel {
  return CONTROL_LABEL.safeParse(name).success;
}

// The open issues, not pull requests, that carry `label`.
function labelledIssues(
  cfg: Config,
  label: ControlLabel,
): Observation<number[]> {
  const path = `repos/${cfg.repo}/issues?state=open&labels=${encodeURIComponent(label)}`;
  const listed = observeAll(cfg, path, LISTED_ISSUE);
  if (listed.status !== "ok") {
    return listed;
  }
  return {
    status: "ok",
    value: listed.value
      .filter((row) => row.pullRequest === undefined)
      .map((row) => row.number),
  };
}

function laterEvent(a: ParsedLabelEvent, b: ParsedLabelEvent): boolean {
  if (a.createdAt !== b.createdAt) {
    return Date.parse(a.createdAt) > Date.parse(b.createdAt);
  }
  return a.id > b.id;
}

function explaining(
  events: readonly ParsedLabelEvent[],
  label: ControlLabel,
): LabelEvent | null {
  let latest: ParsedLabelEvent | null = null;
  for (const event of events) {
    if (
      event.label.name.toLowerCase() === label &&
      (latest === null || laterEvent(event, latest))
    ) {
      latest = event;
    }
  }
  if (latest === null || latest.event !== "labeled") {
    return null;
  }
  let actor: EventActor | null = null;
  if (latest.actor !== null) {
    actor = { ...latest.actor, viaApp: latest.performedViaGithubApp !== null };
  }
  return {
    id: latest.id,
    nodeId: latest.nodeId,
    createdAt: latest.createdAt,
    actor,
  };
}

// The control labels issue `number` carries now and the event explaining
// each, read from the issue and every page of its events. A pull request
// carries none that count.
function labelEvidence(
  cfg: Config,
  number: number,
): Observation<LabelEvidence> {
  const issue = observeOne(cfg, `repos/${cfg.repo}/issues/${number}`, ISSUE);
  if (issue.status !== "ok") {
    return issue;
  }
  const evidence = new Map<ControlLabel, LabelEvent | null>();
  const present = issue.value.labels
    .map((label) => {
      if (typeof label === "string") {
        return label.toLowerCase();
      }
      return label.name.toLowerCase();
    })
    .filter(isControlLabel);
  if (issue.value.pullRequest !== undefined || present.length === 0) {
    return { status: "ok", value: evidence };
  }
  const listed = observeAll(
    cfg,
    `repos/${cfg.repo}/issues/${number}/events`,
    EVENT,
  );
  if (listed.status !== "ok") {
    return listed;
  }
  const events: ParsedLabelEvent[] = [];
  for (const row of listed.value) {
    if (row.event === "labeled" || row.event === "unlabeled") {
      const parsed = LABEL_EVENT.safeParse(row);
      if (!parsed.success) {
        return {
          status: "unknown",
          reason: `label event ${row.id} on #${number} has an unexpected shape`,
        };
      }
      events.push(parsed.data);
    }
  }
  for (const label of present) {
    evidence.set(label, explaining(events, label));
  }
  return { status: "ok", value: evidence };
}

export type { ControlLabel, LabelEvent, LabelEvidence };
export { CONTROL_LABELS, labelEvidence, labelledIssues, START_LABELS };
