// One bounded explicit read-back, no retry, remote write, claim or receipt.
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import { withWikiLock } from "../locks.ts";
import { OpsError } from "../ops-error.ts";
import {
  assertRemote,
  exactRemoteTip,
  validatePreparation,
} from "./authority.ts";
import {
  assertUniqueWikiIntent,
  durableJson,
  readPreparation,
  readRecord,
  recordDir,
} from "./records.ts";
import { COMPLETION, INTENT } from "./schema.ts";
import { importHistory, privateTip, retainedWork } from "./selection.ts";

interface ReconcileRequest {
  number: number;
  id: string;
  lane: string;
  retained: string;
}
function confirmCompletion(folder: string, id: string, next: string): string {
  const completionFile = path.join(folder, "completion.json");
  let response = "lost";
  if (fs.existsSync(completionFile)) {
    const completion = readRecord(completionFile, COMPLETION);
    if (completion.id !== id || completion.new !== next) {
      throw new OpsError("conflicting wiki push completion");
    }
    ({ response } = completion);
  } else {
    durableJson(completionFile, { id, new: next, response });
  }
  return response;
}
function reconcileWikiSync(
  cfg: Config,
  req: ReconcileRequest,
): { adopted: true; id: string; response: string } {
  try {
    return withWikiLock(
      cfg,
      () => {
        const { number: issue, id, lane, retained } = req;
        const prep = readPreparation(cfg, issue, id);
        assertRemote(cfg, retained);
        const folder = recordDir(cfg, issue, id);
        const intent = readRecord(path.join(folder, "intent.json"), INTENT);
        if (intent.id !== id) {
          throw new OpsError("wiki sync intent identity conflict");
        }
        validatePreparation(cfg, issue, prep, { lane, next: intent.new });
        const mirror = paths.wikiMirror(cfg);
        assertRemote(cfg, mirror);
        importHistory(cfg, prep, intent.new, mirror);
        retainedWork(prep, intent.new, retained);
        const privateHead = privateTip(mirror, prep.branch);
        if (privateHead !== prep.old && privateHead !== intent.new) {
          throw new OpsError(
            "additional private wiki commits require explicit reconciliation; both histories retained",
          );
        }
        assertUniqueWikiIntent(cfg, issue, id, intent.new);
        if (exactRemoteTip(cfg, mirror, prep.branch) !== intent.new) {
          throw new OpsError(
            "unresolved wiki push: exact remote does not confirm the intent; explicit operator reconciliation required; do not repeat the push",
          );
        }
        const response = confirmCompletion(folder, id, intent.new);
        durableJson(path.join(folder, "selection.json"), {
          id,
          new: intent.new,
          private: prep.old,
          retained: fs.realpathSync(retained),
          basis:
            "exact intent, histories, original authority and fresh remote read-back",
          kind: "checkpoint",
        });
        return { adopted: true, id, response };
      },
      { wait: false },
    );
  } catch (cause) {
    throw new OpsError(
      `unresolved wiki sync; preserve intent and histories for explicit operator reconciliation; do not repeat the push: ${String(cause)}`,
      { cause },
    );
  }
}

export type { ReconcileRequest };
export { reconcileWikiSync };
