// The coordination records a first claim may ignore (#167): the current
// invocation's own request and confirmation, and any cancelled request's.
// Another run's history is prior work (ops/claim-state.ts).
import type { IssueComment } from "./comments.ts";
import type { Config } from "./config.ts";
import type { Record } from "./coordination-records.ts";
import { RECORD, RECORD_END, RECORD_HEADER } from "./coordination-records.ts";

// The record a comment body holds, unchecked for authority, or null.
function recordIn(body: string): Record | null {
  if (!(body.startsWith(RECORD_HEADER) && body.endsWith(RECORD_END))) {
    return null;
  }
  try {
    const raw: unknown = JSON.parse(
      body.slice(RECORD_HEADER.length, -RECORD_END.length),
    );
    return RECORD.safeParse(raw).data ?? null;
  } catch {
    return null;
  }
}

function instanceOf(record: Record): string {
  if (record.kind === "request") {
    return record.identity.instance;
  }
  return record.instance;
}

// The ids of `comments` that are such records.
function ownHistory(
  cfg: Config,
  comments: readonly IssueComment[],
): Set<number> {
  const rows = comments.flatMap((comment) => {
    const record = recordIn(comment.body ?? "");
    if (record === null) {
      return [];
    }
    return [
      { id: comment.id, kind: record.kind, instance: instanceOf(record) },
    ];
  });
  const ignored = new Set(
    rows.filter((row) => row.kind === "cancel").map((row) => row.instance),
  );
  if (cfg.execution !== undefined) {
    ignored.add(cfg.execution.instance);
  }
  return new Set(
    rows.filter((row) => ignored.has(row.instance)).map((row) => row.id),
  );
}

export { ownHistory };
