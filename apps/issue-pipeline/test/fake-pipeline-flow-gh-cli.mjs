// @ts-check
// The fake GitHub's entry and its `gh pr`, `gh issue` and `gh label`
// commands, and the standards upgrade's reads. A PR's head is read from the bare origin when GitHub is asked;
// the explicit REST merge creates real ordered [P,H] parents. Every PR has one required check, which passes.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { batchAnswer, batchIds } from "./fake-graphql-batch.mjs";
import { api } from "./fake-pipeline-flow-gh-api.mjs";
import {
  hasGates,
  holdAtGate,
  takeGate,
} from "./fake-pipeline-flow-gh-gates.mjs";
import { observeNativeMerges } from "./fake-pipeline-flow-gh-native.mjs";
import { pr } from "./fake-pipeline-flow-gh-prs.mjs";
import { standardsRead } from "./fake-pipeline-flow-gh-standards.mjs";
import {
  flagValue,
  issueOf,
  jsonAnswer,
  postComment,
  withWorld,
} from "./fake-pipeline-flow-gh-world.mjs";

/** @typedef {import("./fake-pipeline-flow-gh-world.mjs").World} World */
/** @typedef {import("./fake-pipeline-flow-gh-world.mjs").Answer} Answer */

const FAKE_IDENTITY = /^fake-pipeline-(?<identity>dev|merge)--(?<login>.+)$/u;
const UNSUPPORTED = "fake-gh: unsupported";
const SOURCE_REF = /^repos\/[^/]+\/[^/]+\/git\/refs\/heads\//u;

/** @param {World} world @param {readonly string[]} args @returns {Answer} */
function issueCommand(world, args) {
  const [, sub, target] = args;
  if (sub === "list") {
    const wanted = flagValue(args, "--label");
    const rows = world.issues
      .filter((each) => each.state === "open" && each.isPull !== true)
      .filter((each) => wanted === null || each.labels.includes(wanted))
      .map((each) => ({
        number: each.number,
        title: each.title,
        body: each.body,
        author: { login: each.login },
        labels: each.labels.map((name) => ({ name })),
        createdAt: each.createdAt,
      }));
    return { stdout: `${JSON.stringify(rows)}\n` };
  }
  const item = issueOf(world, Number(String(target).replace("#", "")));
  if (sub === "view") {
    const labels = item.labels.map((name) => ({ name }));
    const view = { state: item.state.toUpperCase(), labels, title: item.title };
    return jsonAnswer(view, flagValue(args, "--json"));
  }
  if (sub === "reopen") {
    Object.assign(item, { state: "open", stateReason: null });
    return { stdout: "" };
  }
  if (sub !== "close") {
    throw new Error(`${UNSUPPORTED} issue ${sub}`);
  }
  const reason = flagValue(args, "--reason") ?? "completed";
  Object.assign(item, { state: "closed", stateReason: reason });
  const said = flagValue(args, "--comment");
  if (said !== null) {
    postComment(world, item.number, world.account, said);
  }
  return { stdout: "" };
}

/** @param {World} world @param {readonly string[]} args @returns {Answer} */
function labelCommand(world, args) {
  const [, sub, name] = args;
  if (sub === "list") {
    const rows = world.repoLabels.map((each) => ({ name: each }));
    return { stdout: `${JSON.stringify(rows)}\n` };
  }
  if (sub !== "create") {
    throw new Error(`${UNSUPPORTED} label ${sub}`);
  }
  world.repoLabels = [...new Set([...world.repoLabels, String(name)])];
  return { stdout: "" };
}

/** @param {World} world @param {string | undefined} nodeId @returns {object} */
function provenanceNode(world, nodeId) {
  const item = world.comments.find(
    (comment) => `comment-${comment.id}` === nodeId,
  );
  if (item === undefined) {
    throw new Error("unsupported provenance request");
  }
  return {
    databaseId: item.id,
    body: item.body,
    author: { login: item.login },
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    lastEditedAt: null,
    editor: null,
  };
}

/** @param {World} world @param {readonly string[]} args @returns {Answer} */
function commentProvenance(world, args) {
  const batch = batchIds(args);
  if (batch !== null) {
    return {
      stdout: batchAnswer(batch, (each) => provenanceNode(world, each)),
    };
  }
  const id = flagValue(args, "-f");
  const nodeId = args.find((arg) => arg.startsWith("id="))?.slice("id=".length);
  if (id === null) {
    throw new Error("unsupported provenance request");
  }
  const node = provenanceNode(world, nodeId);
  return { stdout: JSON.stringify({ data: { node } }) };
}

/** @param {World} world @param {readonly string[]} args @returns {Answer} */
function answer(world, args) {
  const { GH_TOKEN: ghToken } = process.env;
  const tokenIdentity = FAKE_IDENTITY.exec(ghToken ?? "");
  if (tokenIdentity === null) {
    throw new Error("missing fake credential");
  }
  const { identity, login = "" } = tokenIdentity.groups ?? {};
  if (args[0] === "api" && args[1] === "user") {
    return { stdout: login };
  }
  let expected = "merge";
  if (
    args[0] === "pr" &&
    ["create", "edit", "reopen", "close", "ready"].includes(String(args[1]))
  ) {
    expected = "dev";
  }
  if (
    args[0] === "api" &&
    args.includes("DELETE") &&
    args.some((arg) => SOURCE_REF.test(arg))
  ) {
    expected = "dev";
  }
  if (identity !== expected) {
    throw new Error("wrong fake credential identity");
  }
  if (expected === "merge" && login !== world.account) {
    throw new Error("wrong merge account");
  }
  if (args[0] === "api" && args[1] === "graphql") {
    return commentProvenance(world, args);
  }
  switch (args[0]) {
    case "api":
      return standardsRead(world, args.slice(1)) ?? api(world, args.slice(1));
    case "pr":
      return pr(world, args);
    case "issue":
      return issueCommand(world, args);
    case "run":
      return { stdout: "The greeting CI check failed on this head" };
    case "label":
      return labelCommand(world, args);
    default:
      throw new Error(`${UNSUPPORTED} command ${args[0]}`);
  }
}

/**
 * The fake gh's entry: logs the call, and the account whose fake token made
 * it, answers it from the world and exits; an unsupported call is also kept
 * in the world for the test to see.
 * @param {string} dir
 */
function runFlowGh(dir) {
  const args = process.argv.slice(2);
  fs.appendFileSync(path.join(dir, "calls.jsonl"), `${JSON.stringify(args)}\n`);
  const { GH_TOKEN: token } = process.env;
  const { identity = null, login = null } =
    FAKE_IDENTITY.exec(token ?? "")?.groups ?? {};
  fs.appendFileSync(
    path.join(dir, "accounts.jsonl"),
    `${JSON.stringify({ identity, login, args })}\n`,
  );
  /** @type {import("./fake-pipeline-flow-gh-gates.mjs").Gate | null} */
  let early = null;
  if (hasGates(dir)) {
    early = withWorld(dir, () => takeGate(dir, args, true));
  }
  holdAtGate(dir, early);
  /** @type {Answer} */
  let reply = { code: 1, stderr: "HTTP 502: Bad Gateway\n" };
  /** @type {import("./fake-pipeline-flow-gh-gates.mjs").Gate | null} */
  let gate = null;
  try {
    if (early?.drop !== true) {
      reply = withWorld(dir, (world) => {
        observeNativeMerges(world);
        gate = takeGate(dir, args, false);
        return answer(world, args);
      });
    }
  } catch (error) {
    const message = String(error);
    if (message.includes(UNSUPPORTED)) {
      withWorld(dir, (world) => world.unsupported.push(args));
    }
    reply = { code: 1, stderr: `${message}\n` };
  }
  holdAtGate(dir, gate);
  process.stdout.write(reply.stdout ?? "");
  process.stderr.write(reply.stderr ?? "");
  process.exitCode = reply.code ?? 0;
}

export { runFlowGh };
