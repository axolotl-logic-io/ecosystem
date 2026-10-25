// Generic pi-subagents harness runs (`status.json`, `events.jsonl` and
// output logs under `subagentRuns`). A subagent run is a model session's
// harness record, not a domain buddy run: nothing here names a buddy, task,
// action run or parent.
import { join } from "node:path";
import { z } from "zod";
import { collect } from "./collection.ts";
import type { Config } from "./config.ts";
import { dirs, readCap } from "./local-files.ts";
import {
  type ContactEvent,
  eventSchema,
  jsonl,
  parse,
  type SubagentStatus,
  subagentStatusSchema,
  type Timestamp,
} from "./source-records.ts";
import { ms, today } from "./time.ts";

const blockingContact = /^reason=(?:need_decision|interview_request)\b/u;
const terminalStates = new Set(["complete", "failed", "cancelled", "stopped"]);
const decisions = new Set(["need_decision", "interview_request"]);
const pendingPreviewCharacters = 500;
const eventReadBytes = 65_536;
const outputReadBytes = 8192;
const outputTailLines = 12;
const accountName = z.string().regex(/^[\w.@:/+-]{1,100}$/u);
const accountSchema = z.union([
  accountName,
  z.object({ provider: accountName, login: accountName }),
]);
interface SubagentRun {
  id: string;
  state: string;
  mission: string;
  start?: Timestamp;
  last?: Timestamp;
  pending?: string;
  tail?: string;
  account?: string | null;
  accountSource: string;
}

/** Source metadata is an observation, never proof of identity or authority. */
function observedAccount(input: unknown): string | null {
  const parsed = accountSchema.safeParse(input);
  if (!parsed.success) {
    return null;
  }
  if (typeof parsed.data === "string") {
    return parsed.data;
  }
  return `${parsed.data.provider}:${parsed.data.login}`;
}
function supervisorPending(
  status: SubagentStatus,
  events: ContactEvent[],
): string {
  if (terminalStates.has(status.state)) {
    return "none";
  }
  const waiting = new Map<string, string>();
  for (const event of events) {
    if (event.type === "tool_execution_end") {
      waiting.delete(event.toolCallId);
    } else if (decisions.has(event.args?.reason ?? "")) {
      waiting.set(
        event.toolCallId,
        (event.args?.message ?? event.args?.reason ?? "").slice(
          0,
          pendingPreviewCharacters,
        ),
      );
    }
  }
  if (waiting.size > 0) {
    return [...waiting.values()].join(" | ");
  }
  const blocking = (status.steps ?? [status]).find(
    (step) =>
      step.currentTool === "contact_supervisor" &&
      blockingContact.test(step.currentToolArgs ?? ""),
  );
  return (
    blocking?.currentToolArgs?.slice(0, pendingPreviewCharacters) ?? "none"
  );
}
async function readSubagentRun(
  root: string,
  id: string,
  all: boolean,
): Promise<SubagentRun[]> {
  const directory = join(root, id);
  const parsed = subagentStatusSchema.safeParse(
    parse(await readCap(join(directory, "status.json"))),
  );
  if (!(parsed.success && (all || today(parsed.data.startedAt)))) {
    return [];
  }
  const status = parsed.data;
  const [eventText, output, tail] = await Promise.all([
    readCap(join(directory, "events.jsonl"), eventReadBytes, true),
    readCap(join(directory, "output-0.log"), outputReadBytes),
    readCap(join(directory, "output-0.log"), outputReadBytes, true),
  ]);
  const events = jsonl(eventText).flatMap((record) => {
    const result = eventSchema.safeParse(record);
    if (result.success) {
      return [result.data];
    }
    return [];
  });
  const mission =
    status.task ??
    status.steps?.[0]?.task ??
    output.split("\n")[0] ??
    status.steps?.[0]?.sessionName ??
    "mission unavailable";
  return [
    {
      id,
      state: status.state,
      account: observedAccount(status.account),
      accountSource: "status.json account field; unverified metadata",
      start: status.startedAt,
      last: status.lastActivityAt ?? status.lastUpdate,
      mission: mission.split("\n")[0] ?? "",
      pending: supervisorPending(status, events),
      tail: tail.split("\n").slice(-outputTailLines).join("\n"),
    },
  ];
}
async function loadSubagentRuns(
  config: Config,
  all = false,
): Promise<SubagentRun[]> {
  const runs = await collect(await dirs(config.subagentRuns), (id) =>
    readSubagentRun(config.subagentRuns, id, all),
  );
  return runs.flat().sort((a, b) => ms(b.start) - ms(a.start));
}

export type { SubagentRun };
export { loadSubagentRuns, supervisorPending };
