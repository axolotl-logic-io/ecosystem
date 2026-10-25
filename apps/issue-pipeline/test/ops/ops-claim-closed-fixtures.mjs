// @ts-check
// Specific closed-recovery refusal contracts, shared by row-driven claim tests.
const NOT_OPEN = /#401 is not open/u;
const INVALID_AUTHORITY = /saved write authority is invalid/u;
const LEGACY_AUTHORITY = /legacy pipeline state needs explicit reconciliation/u;
const MERGE_UNCONFIRMED = /incomplete Merge is not confirmed by GitHub/u;
const ATTEMPT_UNCONFIRMED = /saved merge attempt is not confirmed by GitHub/u;
const PR_IDENTITY = /is not from o\/r's agent\/issue-401/u;
const PR_TARGET = /targets elsewhere, not integration/u;
const INCONSISTENT_PR = /has inconsistent merge evidence/u;
const MISSING_MERGE = /pipeline needs a merge commit on integration/u;
const UNREADABLE_MERGE = /unreadable merge/u;
const INVALID_JSON = /JSON/u;
const PROVENANCE = /provenance/u;
const REOPEN_UNCONFIRMED =
  /could not confirm #401 reopened for Merge recovery/u;
const WRONG_BRANCH =
  /work is on another-assignment, not the assigned agent\/issue-401/u;
/** @type {Record<string, RegExp>} */
const STATE_REFUSALS = {
  done: NOT_OPEN,
  author: NOT_OPEN,
  implement: NOT_OPEN,
  review: NOT_OPEN,
  "stopped outside Merge": NOT_OPEN,
  "no recorded PR": NOT_OPEN,
  "state for another issue": INVALID_AUTHORITY,
  "legacy state": LEGACY_AUTHORITY,
  "stopped completion replay": INVALID_AUTHORITY,
  "malformed code receipt": INVALID_AUTHORITY,
  "contradicted code receipt": MERGE_UNCONFIRMED,
  "contradicted PR receipt": MERGE_UNCONFIRMED,
  "contradicted own receipt": MERGE_UNCONFIRMED,
  "changed retained head": MERGE_UNCONFIRMED,
  "contradicted original own-merge head": MERGE_UNCONFIRMED,
};
/** @type {Record<string, RegExp>} */
const PR_REFUSALS = {
  open: MERGE_UNCONFIRMED,
  "inconsistent open merge evidence": INCONSISTENT_PR,
  "another recorded PR": PR_IDENTITY,
  "closed unmerged": MERGE_UNCONFIRMED,
  "missing merged result": MISSING_MERGE,
  "malformed merged result": MERGE_UNCONFIRMED,
  "abbreviated merged result": MERGE_UNCONFIRMED,
  "blank merged result": MERGE_UNCONFIRMED,
  "wrong configured base": PR_TARGET,
  "wrong branch": PR_IDENTITY,
  fork: PR_IDENTITY,
};

/** @param {Record<string, RegExp>} table @param {string} name */
function refusalOf(table, name) {
  const refusal = table[name];
  if (refusal === undefined) {
    throw new Error(`no closed-recovery refusal for ${name}`);
  }
  return refusal;
}

export {
  ATTEMPT_UNCONFIRMED,
  INVALID_JSON,
  MERGE_UNCONFIRMED,
  NOT_OPEN,
  PR_REFUSALS,
  PROVENANCE,
  REOPEN_UNCONFIRMED,
  refusalOf,
  STATE_REFUSALS,
  UNREADABLE_MERGE,
  WRONG_BRANCH,
};
