import { join } from "node:path";
import { observedAccount } from "./buddy-source.ts";
import { collect } from "./collection.ts";
import type { Config } from "./config.ts";
import { dirs, readCap } from "./local-files.ts";
import {
  type BuddyStatus,
  buddyStatusSchema,
  type ContactEvent,
  eventSchema,
  jsonl,
  parse,
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
interface BuddyRun {
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
function supervisorPending(
  status: BuddyStatus,
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
async function readBuddyRun(
  root: string,
  id: string,
  all: boolean,
): Promise<BuddyRun[]> {
  const directory = join(root, id);
  const parsed = buddyStatusSchema.safeParse(
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
async function loadBuddyRuns(config: Config, all = false): Promise<BuddyRun[]> {
  const runs = await collect(await dirs(config.buddyRuns), (id) =>
    readBuddyRun(config.buddyRuns, id, all),
  );
  return runs.flat().sort((a, b) => ms(b.start) - ms(a.start));
}

export type { BuddyRun };
export { loadBuddyRuns, supervisorPending };
