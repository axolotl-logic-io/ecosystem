// Admission of an approved upgrade plan into issue delivery (#129): the
// read-only check that issue N may carry a standards upgrade through the
// buddy's tasks. The plan must have been filed by an allow-listed person,
// since neither pipeline account is trusted input. It must name this
// repository and the current policy, and be bound to the base branch's
// current head. It must also be the repository's only open upgrade issue.
// Admission writes nothing and does not produce a qualified start signal or
// bypass any task guard.

import { z } from "zod";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import { ghJson, git, isAllowedUser } from "../github.ts";
import type { PlanMarker } from "./schema.ts";
import { PLAN_MARKER, PLAN_TAG, POLICY_VERSION } from "./schema.ts";
import { Refusal } from "./source.ts";

const MARKER = /<!-- standards-upgrade:plan (?<json>\{[^\n]*\}) -->/gu;
const ISSUE_LIST_LIMIT = 300;
const WHITESPACE = /\s/u;
const ISSUE_JQ =
  "{body, state, login: .user.login, pull: (.pull_request != null)}";
const ISSUE = z.object({
  body: z.string().nullable(),
  state: z.string(),
  login: z.string().nullable(),
  pull: z.boolean(),
});
const ROWS = z.array(
  z.looseObject({ number: z.number(), body: z.string().nullish() }),
);

interface Admission {
  issue: number;
  branch: string;
  marker: PlanMarker;
}

// The one plan marker in `body`, or a Refusal.
function markerOf(n: number, body: string): PlanMarker {
  const found = [...body.matchAll(MARKER)];
  const [only] = found;
  if (found.length !== 1 || only === undefined) {
    throw new Refusal(`#${n} doesn't carry exactly one standards upgrade plan`);
  }
  const { json = "" } = only.groups ?? {};
  try {
    return PLAN_MARKER.parse(JSON.parse(json));
  } catch (error) {
    throw new Refusal(`#${n}'s plan marker doesn't parse`, { cause: error });
  }
}

function planIssue(cfg: Config, n: number): PlanMarker {
  const args = ["api", `repos/${cfg.repo}/issues/${n}`, "--jq", ISSUE_JQ];
  const parsed = ISSUE.safeParse(
    ghJson(cfg, "landing", args, { allowFail: true }),
  );
  if (!parsed.success) {
    throw new Refusal(`GitHub doesn't show issue #${n} readable`);
  }
  const { body, state, login, pull } = parsed.data;
  if (pull || state !== "open") {
    throw new Refusal(`#${n} isn't an open issue`);
  }
  if (!isAllowedUser(cfg, login)) {
    throw new Refusal(
      `#${n} was filed by @${String(login)}, who isn't an allow-listed collaborator; only an allow-listed person approves a plan`,
    );
  }
  const marker = markerOf(n, body ?? "");
  if (marker.repo.toLowerCase() !== cfg.repo.toLowerCase()) {
    throw new Refusal(`#${n}'s plan is for ${marker.repo}, not ${cfg.repo}`);
  }
  if (marker.policy !== POLICY_VERSION) {
    throw new Refusal(
      `#${n}'s plan follows ${marker.policy}, not ${POLICY_VERSION}; reassess`,
    );
  }
  return marker;
}

function baseHead(cfg: Config): string | null {
  const url = cfg.cloneUrl || `https://github.com/${cfg.repo}.git`;
  const ref = `refs/heads/${cfg.baseBranch}`;
  const { code, stdout } = git(cfg, "landing", ["ls-remote", url, ref], {
    allowFail: true,
  });
  const [sha = ""] = stdout.trim().split(WHITESPACE);
  if (code !== 0 || sha === "") {
    return null;
  }
  return sha;
}

function otherPlans(cfg: Config, n: number): number[] {
  const args = [
    "issue",
    "list",
    "-R",
    cfg.repo,
    "--state",
    "open",
    "--limit",
    String(ISSUE_LIST_LIMIT),
    "--json",
    "number,body",
  ];
  const rows = ROWS.safeParse(
    ghJson(cfg, "landing", args, { allowFail: true }),
  );
  if (!rows.success || rows.data.length >= ISSUE_LIST_LIMIT) {
    throw new Refusal(
      "the open issues couldn't be listed completely, so another upgrade issue can't be ruled out",
    );
  }
  return rows.data
    .filter((row) => row.number !== n && (row.body ?? "").includes(PLAN_TAG))
    .map((row) => row.number);
}

// Admits issue `n`, or throws a Refusal naming what doesn't hold.
function admit(cfg: Config, n: number): Admission {
  const marker = planIssue(cfg, n);
  const head = baseHead(cfg);
  if (head === null) {
    throw new Refusal(`${cfg.baseBranch}'s head couldn't be read`);
  }
  if (head !== marker.source) {
    throw new Refusal(
      `#${n}'s plan was assessed at ${marker.source}, but ${cfg.baseBranch} is now at ${head}; reassess and file a new plan`,
    );
  }
  const others = otherPlans(cfg, n);
  if (others.length > 0) {
    throw new Refusal(
      `#${others.join(", #")} already carries an open upgrade plan; continue or close it first`,
    );
  }
  return { issue: n, branch: paths.branch(cfg, n), marker };
}

export type { Admission };
export { admit };
