// @ts-check
// What a list of gh writes (fake-gh's writes()) shows on GitHub, named so a
// test can check the effects a promise names without copying gh's argv or a
// comment's full text: which issue or PR gets a comment, which comment is
// edited, which labels are added or removed, which issues are opened and
// linked as sub-issues. A comment is named by the role
// in its `agent-pipeline:comment role=` marker, or as the state comment.

const ISSUE_COMMENTS =
  /^repos\/[^/]+\/[^/]+\/issues\/(?<posted>\d+)\/comments$/u;
const COMMENT = /^repos\/[^/]+\/[^/]+\/issues\/comments\/(?<edited>\d+)$/u;
const ISSUE_LABELS =
  /^repos\/[^/]+\/[^/]+\/issues\/(?<labelled>\d+)\/labels(?:\/(?<name>.+))?$/u;
const ISSUES = /^repos\/[^/]+\/[^/]+\/issues$/u;
const SUB_ISSUES = /^repos\/[^/]+\/[^/]+\/issues\/(?<parent>\d+)\/sub_issues$/u;
const ROLE = /<!-- agent-pipeline:comment role=(?<role>[\w-]+) -->/u;
const STATE = /<!-- agent-pipeline:state\n(?<json>.*)\n-->/u;
const LABEL_EFFECT = /^(?:un)?label /u;
const BODY_FIELD = "body=";
const LABEL_FIELD = "labels[]=";
const TITLE_FIELD = "title=";
const SUB_ISSUE_FIELD = "sub_issue_id=";

/**
 * One write's effect: its name, and the comment text it posts, if any.
 * @typedef {object} GhEffect
 * @property {string} effect
 * @property {string} body
 */

/** @param {readonly string[]} args @param {string} prefix @returns {string} */
function field(args, prefix) {
  const found = args.find((arg) => arg.startsWith(prefix));
  if (found === undefined) {
    return "";
  }
  return found.slice(prefix.length);
}

// The named groups of `pattern`'s match in `text`, none if it doesn't match.
/** @param {RegExp} pattern @param {string} text @returns {Record<string, string>} */
function groupsOf(pattern, text) {
  return pattern.exec(text)?.groups ?? {};
}

/** @param {string} body @returns {string} */
function kindOf(body) {
  const { role } = groupsOf(ROLE, body);
  if (role !== undefined) {
    return ` role=${role}`;
  }
  if (STATE.test(body)) {
    return " state";
  }
  return "";
}

/** @param {readonly string[]} args @returns {string} */
function nameOf(args) {
  const endpoint = args.find((arg) => arg.startsWith("repos/")) ?? "";
  const kind = kindOf(field(args, BODY_FIELD));
  if (ISSUES.test(endpoint)) {
    return `issue ${field(args, TITLE_FIELD)}`;
  }
  const { parent } = groupsOf(SUB_ISSUES, endpoint);
  if (parent !== undefined) {
    return `sub-issue #${parent} id ${field(args, SUB_ISSUE_FIELD)}`;
  }
  const { posted } = groupsOf(ISSUE_COMMENTS, endpoint);
  if (posted !== undefined && args.includes("POST")) {
    return `comment #${posted}${kind}`;
  }
  const { edited } = groupsOf(COMMENT, endpoint);
  if (edited !== undefined && args.includes("PATCH")) {
    return `edit comment ${edited}${kind}`;
  }
  const { labelled, name } = groupsOf(ISSUE_LABELS, endpoint);
  if (name !== undefined && args.includes("DELETE")) {
    return `unlabel #${labelled} ${decodeURIComponent(name)}`;
  }
  if (labelled !== undefined && args.includes("POST")) {
    return `label #${labelled} ${field(args, LABEL_FIELD)}`;
  }
  return args.filter((arg) => !arg.startsWith(BODY_FIELD)).join(" ");
}

/** @param {readonly string[][]} writes @returns {GhEffect[]} */
function effectsOf(writes) {
  return writes.map((args) => ({
    effect: nameOf(args),
    body: field(args, BODY_FIELD),
  }));
}

// The effects' names, sorted, so a check doesn't pin the order of the writes.
// A label added or removed twice is named once: GitHub shows no difference.
/** @param {readonly GhEffect[]} effects @returns {string[]} */
function effectNames(effects) {
  const names = effects.map(({ effect }) => effect);
  const once = names.filter(
    (name, at) => !LABEL_EFFECT.test(name) || names.indexOf(name) === at,
  );
  return once.sort();
}

// The text of the first write named `name`; throws if there is none.
/** @param {readonly GhEffect[]} effects @param {string} name @returns {string} */
function bodyOf(effects, name) {
  const found = effects.find(({ effect }) => effect === name);
  if (found === undefined) {
    throw new Error(`no ${name} among ${effectNames(effects).join(", ")}`);
  }
  return found.body;
}

// The state the first write named `name` saves.
/** @param {readonly GhEffect[]} effects @param {string} name @returns {unknown} */
function stateOf(effects, name) {
  const { json } = groupsOf(STATE, bodyOf(effects, name));
  if (json === undefined) {
    throw new Error(`${name} saves no state`);
  }
  return JSON.parse(json);
}

export { bodyOf, effectNames, effectsOf, stateOf };
