// The hidden markers task runs leave in their issue comments, so later runs
// can find them. A marker is one HTML comment at the end of the body,
// naming the task, a kind and a JSON payload; GitHub doesn't show it.
// `end` is the framework's own kind: the end comment of a run that won its
// claim, or of a start it couldn't confirm.
import { z } from "zod";

const MARKER =
  /<!-- task-app:(?<task>[a-z][a-z0-9-]*):(?<kind>[a-z][a-z0-9-]*) (?<payload>\{.*?\}) -->/u;
const TASK_ID = /^[a-z][a-z0-9-]*$/u;

const END = z.strictObject({
  run: z.uuid(),
  // The `labeled` event of the start this run took, and the `unlabeled`
  // event of its claim, or null when the claim was never confirmed.
  start: z.number().int().positive().nullable(),
  claim: z.number().int().positive().nullable(),
  outcome: z.enum(["succeeded", "failed", "stopped", "unconfirmed"]),
});

type EndMark = z.infer<typeof END>;
interface Mark {
  task: string;
  kind: string;
  payload: unknown;
}

function isTaskId(task: string): boolean {
  return TASK_ID.test(task);
}

// `text` with a marker of `task`'s `kind` carrying `payload`.
function marked(
  text: string,
  task: string,
  kind: string,
  payload: object,
): string {
  if (!(isTaskId(task) && TASK_ID.test(kind))) {
    throw new Error(`not a marker name: ${task}:${kind}`);
  }
  return `${text}\n\n<!-- task-app:${task}:${kind} ${JSON.stringify(payload)} -->`;
}

// The marker `body` carries, or null when it has none or a malformed one.
function markOf(body: string): Mark | null {
  const { task, kind, payload } = MARKER.exec(body)?.groups ?? {};
  if (task === undefined || kind === undefined || payload === undefined) {
    return null;
  }
  try {
    return { task, kind, payload: JSON.parse(payload) };
  } catch {
    return null;
  }
}

// The end marker of `task` that `body` carries, or null.
function endMarkOf(body: string, task: string): EndMark | null {
  const mark = markOf(body);
  if (mark === null || mark.task !== task || mark.kind !== "end") {
    return null;
  }
  const parsed = END.safeParse(mark.payload);
  if (!parsed.success) {
    return null;
  }
  return parsed.data;
}

export type { EndMark, Mark };
export { endMarkOf, isTaskId, marked, markOf };
