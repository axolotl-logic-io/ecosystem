// Reads the record the ops CLI writes before it pushes an issue's branch.
import fs from "node:fs";
import path from "node:path";

const ISO_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u;

// The push record for issue `n` under the pipeline root `root`, with whether
// its time is an ISO time in place of the time.
function pushRecord(
  root: string,
  n: number,
): { [field: string]: unknown; dated: boolean } {
  const file = path.join(root, "runs", "o__r", `issue-${n}`, "pushed.json");
  const { at, ...record } = JSON.parse(fs.readFileSync(file, "utf8"));
  return { ...record, dated: ISO_TIME.test(at) };
}

export { pushRecord };
