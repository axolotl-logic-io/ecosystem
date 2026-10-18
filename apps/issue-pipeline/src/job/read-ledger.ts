// The read ledger a stage job appends to a writer session's handoff
// (spec-read-ledger): the files the session opened with pi's `read` tool and
// the line ranges it read of each, taken from the session's RPC records, so
// the next session rereads only what it needs. A read counts once its tool
// call ends without an error. Each file is listed once, in the order it was
// first read, with its ranges merged; `N-` is a read from line N with no
// limit, as far as the tool went. stop-handoff.ts appends it to the file.

import { z } from "zod";

// The longest list of files the ledger gives; the rest are counted.
const LEDGER_FILES = 120;
const READ_START = z.object({
  type: z.literal("tool_execution_start"),
  toolCallId: z.string(),
  toolName: z.literal("read"),
  args: z.looseObject({
    path: z.string(),
    offset: z.number().int().positive().optional(),
    limit: z.number().int().positive().optional(),
  }),
});
const TOOL_END = z.object({
  type: z.literal("tool_execution_end"),
  toolCallId: z.string(),
  isError: z.boolean().optional(),
});

// One read: the file as the session named it, and its first line (from 1)
// and last, null when it read on with no limit.
interface Read {
  file: string;
  start: number;
  end: number | null;
}

// The reads a session made, gathered from its records as they come.
interface ReadLedger {
  record: (record: unknown) => void;
  reads: () => readonly Read[];
}

function readOf(args: z.infer<typeof READ_START>["args"]): Read {
  const start = args.offset ?? 1;
  let end: number | null = null;
  if (args.limit !== undefined) {
    end = start + args.limit - 1;
  }
  return { file: args.path, start, end };
}

// A ledger that gathers the reads that ended without an error.
function readLedger(): ReadLedger {
  const pending = new Map<string, Read>();
  const done: Read[] = [];
  return {
    record: (record: unknown): void => {
      const start = READ_START.safeParse(record);
      if (start.success) {
        pending.set(start.data.toolCallId, readOf(start.data.args));
        return;
      }
      const end = TOOL_END.safeParse(record);
      if (!end.success) {
        return;
      }
      const read = pending.get(end.data.toolCallId);
      pending.delete(end.data.toolCallId);
      if (read !== undefined && end.data.isError !== true) {
        done.push(read);
      }
    },
    reads: (): readonly Read[] => done,
  };
}

// `ranges` sorted and merged where they overlap or touch.
function merged(ranges: readonly Read[]): Read[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out: Read[] = [];
  for (const range of sorted) {
    const last = out.at(-1);
    if (
      last === undefined ||
      (last.end !== null && range.start > last.end + 1)
    ) {
      out.push({ ...range });
    } else if (last.end !== null && range.end === null) {
      last.end = null;
    } else if (last.end !== null && range.end !== null) {
      last.end = Math.max(last.end, range.end);
    }
  }
  return out;
}

function rangeText(range: Read): string {
  if (range.end === null) {
    return `${range.start}-`;
  }
  if (range.end === range.start) {
    return `${range.start}`;
  }
  return `${range.start}-${range.end}`;
}

// The ledger's lines for `reads`: one per file as `shown` names it, in
// first-read order.
function ledgerLines(
  reads: readonly Read[],
  shown: (file: string) => string,
): string[] {
  const byFile = new Map<string, Read[]>();
  for (const read of reads) {
    const file = shown(read.file);
    byFile.set(file, [...(byFile.get(file) ?? []), read]);
  }
  const lines = [...byFile].slice(0, LEDGER_FILES).map(([file, ranges]) => {
    const text = merged(ranges).map(rangeText).join(", ");
    return `- \`${file}\`: ${text}`;
  });
  if (byFile.size > LEDGER_FILES) {
    lines.push(`- and ${byFile.size - LEDGER_FILES} more files`);
  }
  return lines;
}

// The handoff's section listing what session `key` read, each file as
// `shown` names it, or null when it read nothing.
function readLedgerText(
  key: string,
  reads: readonly Read[],
  shown: (file: string) => string,
): string | null {
  if (reads.length === 0) {
    return null;
  }
  return [
    `## Files session ${key} read (written by the job)`,
    "",
    "The files this session opened with `read` and the lines it read of each, relative to its working directory; `N-` means from line N as far as the tool went. Reread only what you need.",
    "",
    ...ledgerLines(reads, shown),
    "",
  ].join("\n");
}

export type { Read, ReadLedger };
export { readLedger, readLedgerText };
