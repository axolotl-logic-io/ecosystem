// @ts-check
// Real SQLite via its CLI; every query is bounded and leaves no service behind.
import { execFileSync } from "node:child_process";

const QUERY_TIMEOUT_MS = 10_000;

/** @param {string} database @param {string} query @returns {string} */
function sql(database, query) {
  return execFileSync("sqlite3", [database, query], {
    encoding: "utf8",
    timeout: QUERY_TIMEOUT_MS,
  }).trim();
}

export { sql };
