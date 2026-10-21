// GitHub's branch-merge mutation names a literal configured destination and
// immutable authorized source. Unlike PR merge, retargeting cannot redirect
// it. It is not expected-base CAS and cannot atomically bind PR or input
// state. Writes run once, including ambiguous transport failures.
import { z } from "zod";
import type { Config } from "../config.ts";
import { gh } from "../github.ts";
import { OpsError } from "../ops-error.ts";
import { tail } from "../process.ts";
import { FULL_SHA } from "./merged-graph.ts";

const REFUSAL_TAIL_LINES = 5;
const HTTP_RESPONSE =
  /^HTTP\/\S+ (?<status>\d{3})[^\r\n]*\r?\n(?:[^\r\n]+\r?\n)*\r?\n(?<body>[\s\S]*)$/u;
const REJECTED_STATUSES: ReadonlySet<string> = new Set([
  "403",
  "404",
  "409",
  "422",
]);
const MERGE_BODY = z.looseObject({ sha: FULL_SHA });

type BranchMerge = { sha: string } | { merged: false; reason: string };

// Only 201 with a valid full result SHA is a candidate own receipt; the
// caller must still confirm genuine same-PR MERGED metadata and graph.
function branchMerge(cfg: Config, head: string): BranchMerge {
  FULL_SHA.parse(head);
  const { repo, baseBranch: base } = cfg;
  const args = [
    "api",
    `repos/${repo}/merges`,
    "--method",
    "POST",
    "--include",
    "-f",
    `base=${base}`,
    "-f",
    `head=${head}`,
  ];
  const result = gh(cfg, "merge", args, { allowFail: true });
  const { status, body = "" } = HTTP_RESPONSE.exec(result.stdout)?.groups ?? {};
  if (result.code !== 0 || status !== "201") {
    let outcome = `unconfirmed merge outcome (${status ?? "no HTTP status"})`;
    if (status !== undefined && REJECTED_STATUSES.has(status)) {
      outcome = `branch merge rejected (HTTP ${status}), with no own receipt`;
    }
    if (result.code === 0 && status === "204") {
      outcome = "already merged (HTTP 204), with no fresh own receipt";
    }
    // No current-base/head/test-merge substitution. A fresh claim may record
    // genuine external metadata, but needs existing postmerge authorization.
    return {
      merged: false,
      reason: `${outcome}; code may already have landed; stop for read-only reconciliation, not a mutation retry: ${tail(result.stderr, REFUSAL_TAIL_LINES)}`,
    };
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Malformed success is uncertain, not permission to repeat the POST.
  }
  const receipt = MERGE_BODY.safeParse(parsed);
  if (!receipt.success) {
    throw new OpsError(
      "HTTP 201 has no valid merge SHA; code may already have landed; stop for read-only reconciliation",
    );
  }
  return receipt.data;
}

export { branchMerge };
