// @ts-check
// The fake GitHub's `gh api` routes: only the REST calls the pipeline makes,
// each served from the world, and `--jq` only for the filters it passes.
// Any other route or filter is refused as unsupported.
import {
  branchHead,
  gitIn,
  issueOf,
  postComment,
  restComment,
  restIssue,
} from "./pipeline-flow-gh-world.mjs";

/** @typedef {import("./pipeline-flow-gh-world.mjs").World} World */
/** @typedef {import("./pipeline-flow-gh-world.mjs").Answer} Answer */

/**
 * A call's parts: its method, route less query, query, fields, filter and
 * whether it prints nothing.
 * @typedef {object} ApiCall
 * @property {string} method
 * @property {string[]} route the route's parts after repos/<owner>/<repo>/
 * @property {URLSearchParams} query
 * @property {string[]} fields
 * @property {string | null} jq
 * @property {boolean} silent
 */

const METHOD_FLAG = /^(?:-X|--method)$/u;
const FIELD_FLAG = /^(?:-f|-F|--field|--raw-field)$/u;
const JQ_FLAG = /^(?:--jq|-q)$/u;
const LABEL_FIELD = "labels[]=";
const SUB_ISSUES_JQ = "[.[] | {number, state";

/**
 * @param {readonly string[]} args the arguments after `api`
 * @returns {{ method: string, endpoint: string, fields: string[], jq: string | null }}
 */
function flagsOf(args) {
  const parsed = { method: "GET", endpoint: "", fields: [], jq: null };
  /** @type {string[]} */
  const fields = [];
  let at = 0;
  while (at < args.length) {
    const arg = String(args[at]);
    const value = String(args[at + 1]);
    at += 1;
    if (METHOD_FLAG.test(arg)) {
      parsed.method = value;
      at += 1;
    } else if (FIELD_FLAG.test(arg)) {
      fields.push(value);
      at += 1;
    } else if (JQ_FLAG.test(arg)) {
      Object.assign(parsed, { jq: value });
      at += 1;
    } else if (!arg.startsWith("-") && parsed.endpoint === "") {
      parsed.endpoint = arg;
    }
  }
  return { ...parsed, fields };
}

/**
 * @param {World} world @param {readonly string[]} args the arguments after `api`
 * @returns {ApiCall}
 */
function callOf(world, args) {
  const { method, endpoint, fields, jq } = flagsOf(args);
  const [route = "", query = ""] = endpoint.split("?");
  const prefix = `repos/${world.repo}/`;
  let parts = [route];
  if (route.startsWith(prefix)) {
    parts = route.slice(prefix.length).split("/");
  } else if (route !== "user") {
    throw new Error(`fake-gh: unsupported api ${route}`);
  }
  const silent = args.includes("--silent");
  const search = new URLSearchParams(query);
  return { method, route: parts, query: search, fields, jq, silent };
}

/**
 * gh's `--jq` for the few filters the pipeline uses.
 * @param {unknown} value @param {string | null} jq @returns {string}
 */
function filtered(value, jq) {
  if (jq === null) {
    return `${JSON.stringify(value)}\n`;
  }
  if (jq === ".[] | @json" && Array.isArray(value)) {
    return value.map((item) => `${JSON.stringify(item)}\n`).join("");
  }
  const record = /** @type {Record<string, unknown>} */ (value);
  if (jq === ".id" || jq === ".login") {
    return `${String(record[jq.slice(1)])}\n`;
  }
  if (jq === "{state}") {
    const { state } = record;
    return `${JSON.stringify({ state })}\n`;
  }
  if (jq.startsWith(SUB_ISSUES_JQ) && Array.isArray(value)) {
    return `${JSON.stringify(value)}\n`;
  }
  throw new Error(`fake-gh: unsupported --jq ${jq}`);
}

/** @param {ApiCall} call @param {unknown} value @returns {Answer} */
function printed(call, value) {
  if (call.silent) {
    return { stdout: "" };
  }
  return { stdout: filtered(value, call.jq) };
}

/** @param {readonly string[]} fields @param {string} key @returns {string | null} */
function fieldOf(fields, key) {
  const found = fields.find((field) => field.startsWith(`${key}=`));
  if (found === undefined) {
    return null;
  }
  return found.slice(key.length + 1);
}

/** @param {World} world @param {ApiCall} call @returns {Answer} */
function repoComments(world, call) {
  const [, id] = call.route;
  if (id === undefined) {
    const since = call.query.get("since") ?? "";
    const listed = world.comments.filter((item) => item.updatedAt >= since);
    return printed(
      call,
      listed.map((item) => restComment(world, item)),
    );
  }
  const found = world.comments.find((item) => item.id === Number(id));
  if (found === undefined || call.method !== "PATCH") {
    return { code: 1, stderr: "HTTP 404: Not Found" };
  }
  found.body = fieldOf(call.fields, "body") ?? found.body;
  found.updatedAt = new Date().toISOString();
  return printed(call, restComment(world, found));
}

/** @param {World} world @param {ApiCall} call @returns {Answer} */
function issueLabels(world, call) {
  const [, n, , name] = call.route;
  const item = issueOf(world, Number(n));
  if (call.method === "POST") {
    const added = call.fields.map((field) => field.slice(LABEL_FIELD.length));
    item.labels = [...new Set([...item.labels, ...added])];
  } else if (call.method === "DELETE") {
    const gone = decodeURIComponent(String(name));
    item.labels = item.labels.filter((have) => have !== gone);
  }
  return printed(
    call,
    item.labels.map((have) => ({ name: have })),
  );
}

/** @param {World} world @param {ApiCall} call @returns {Answer} */
function issueRoute(world, call) {
  const [, n, part] = call.route;
  const number = Number(n);
  const item = issueOf(world, number);
  if (part === undefined && call.method === "GET") {
    return printed(call, restIssue(item));
  }
  if (part === "labels") {
    return issueLabels(world, call);
  }
  if (part === "sub_issues") {
    return printed(call, []);
  }
  if (part === "comments" && call.method === "POST") {
    const body = fieldOf(call.fields, "body") ?? "";
    const posted = postComment(world, number, world.account, body);
    return printed(call, restComment(world, posted));
  }
  if (part === "comments") {
    const listed = world.comments.filter((each) => each.issue === number);
    return printed(
      call,
      listed.map((each) => restComment(world, each)),
    );
  }
  throw new Error(`fake-gh: unsupported api ${call.method} ${n}/${part}`);
}

/** @param {World} world @param {ApiCall} call @returns {Answer} */
function deleteBranch(world, call) {
  const [, , , ...name] = call.route;
  const branch = name.join("/");
  if (call.method !== "DELETE" || branchHead(world.origin, branch) === null) {
    return { code: 1, stderr: "HTTP 422: Reference does not exist" };
  }
  gitIn(world.origin, ["update-ref", "-d", `refs/heads/${branch}`]);
  return { stdout: "" };
}

/**
 * Answers `gh api …` from the world.
 * @param {World} world @param {readonly string[]} args the arguments after `api`
 * @returns {Answer}
 */
function api(world, args) {
  const call = callOf(world, args);
  const [kind, second] = call.route;
  if (kind === "user") {
    return printed(call, { login: world.account });
  }
  if (kind === "collaborators") {
    if (world.collaborators.includes(String(second))) {
      return { stdout: "" };
    }
    return { code: 1, stderr: "HTTP 404: Not Found" };
  }
  if (kind === "git" && second === "refs") {
    return deleteBranch(world, call);
  }
  if (kind === "issues" && second === "comments") {
    return repoComments(world, { ...call, route: call.route.slice(1) });
  }
  if (kind === "issues") {
    return issueRoute(world, call);
  }
  throw new Error(`fake-gh: unsupported api ${call.route.join("/")}`);
}

export { api };
