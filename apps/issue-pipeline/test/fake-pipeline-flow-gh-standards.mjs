// @ts-check
// The fake GitHub's answers to the standards upgrade's reads (#129): the
// repository itself, the base branch's protection and rulesets, which the
// world never has (GitHub's 404), and an issue read through the filter
// `standards-upgrade apply` passes. Each answer is computed from the world,
// and any other filter on these routes is refused.
import { flagsOf } from "./fake-pipeline-flow-gh-api.mjs";
import { issueOf } from "./fake-pipeline-flow-gh-world.mjs";

/** @typedef {import("./fake-pipeline-flow-gh-world.mjs").World} World */
/** @typedef {import("./fake-pipeline-flow-gh-world.mjs").Answer} Answer */

const REPOSITORY_JQ =
  "{fullName: .full_name, archived, defaultBranch: .default_branch}";
const ISSUE_JQ =
  "{body, state, login: .user.login, pull: (.pull_request != null)}";
const NOT_PROTECTED = {
  code: 1,
  stderr: "gh: Branch not protected (HTTP 404)",
};

/** @param {string | null} jq @param {string} wanted */
function refuseOtherFilter(jq, wanted) {
  if (jq !== wanted) {
    throw new Error(`fake-gh: unsupported --jq ${String(jq)}`);
  }
}

/**
 * The answer to a standards upgrade read, or null for any other call.
 * @param {World} world @param {readonly string[]} args the arguments after `api`
 * @returns {Answer | null}
 */
function standardsRead(world, args) {
  const { method, endpoint, jq } = flagsOf(args);
  const repo = `repos/${world.repo}`;
  if (method !== "GET" || !endpoint.startsWith(repo)) {
    return null;
  }
  const route = endpoint.slice(repo.length).split("/").slice(1);
  const [kind, second, third] = route;
  if (endpoint === repo) {
    refuseOtherFilter(jq, REPOSITORY_JQ);
    const view = {
      fullName: world.repo,
      archived: false,
      defaultBranch: world.baseBranch,
    };
    return { stdout: `${JSON.stringify(view)}\n` };
  }
  if (kind === "rules" || (kind === "branches" && third === "protection")) {
    return NOT_PROTECTED;
  }
  if (kind === "issues" && route.length === 2 && jq === ISSUE_JQ) {
    const item = issueOf(world, Number(second));
    const view = {
      body: item.body,
      state: item.state,
      login: item.login,
      pull: item.isPull === true,
    };
    return { stdout: `${JSON.stringify(view)}\n` };
  }
  return null;
}

export { standardsRead };
