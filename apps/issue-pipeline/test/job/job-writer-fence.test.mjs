// @ts-check
// A job that loses ownership between its claim and its first session starts
// no session (#168). The fake ops' claim succeeds, then a successor takes
// the issue through the real coordination transport (fake-job-successor.mjs):
// the job's own reads see that, refuse the writer, change nothing of the
// successor's, and keep why in job.json and on stderr.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { waitFor } from "../bounded-test-kit.mjs";
import {
  AUTHOR_SESSION,
  IMPLEMENTOR_SESSION,
  implementReplies,
  READER_STAGE,
  repliesAt,
} from "../job-fixtures.mjs";
import { coordinationRecords } from "./fake-job-coordination.mjs";
import {
  logOf,
  piCommands,
  piStarts,
  runJob,
  setUp,
  startJob,
  statusOf,
} from "./job-test-kit.mjs";

const LOST = /execution ownership lost or unconfirmed/u;

/** @param {Record<string, any>} replies */
function withSuccessor(replies) {
  const { claim } = replies;
  return { ...replies, claim: { ...claim, successor: true } };
}

const PATHS = [
  {
    path: "Author",
    replies: withSuccessor(repliesAt(READER_STAGE)),
    session: AUTHOR_SESSION,
    stage: READER_STAGE,
  },
  {
    path: "Implementation writer",
    replies: withSuccessor(implementReplies()),
    session: IMPLEMENTOR_SESSION,
    stage: "implement",
  },
];

for (const each of PATHS) {
  test(`the ${each.path} path starts no session once a successor took the issue after the claim`, () => {
    const place = setUp(each.replies, each.session);
    const r = runJob(place, ["--stage", each.stage, "--lane", "L"]);
    assert.deepEqual(piStarts(place), []);
    const records = coordinationRecords(place.root);
    const successor = records.findLast(
      ({ kind, identity }) =>
        kind === "request" && identity.lane === "successor",
    );
    assert.ok(successor);
    // Nothing follows the successor's request and confirmation.
    assert.deepEqual(
      records.slice(records.indexOf(successor)).map(({ kind }) => kind),
      ["request", "confirm"],
    );
    assert.match(`${r.stdout}${r.stderr}`, LOST);
    assert.match(JSON.stringify(statusOf(place)), LOST);
  });
}

const SUCCESSOR = new URL("./fake-job-successor.mjs", import.meta.url).pathname;

/** @param {string} socket @param {object} request @returns {Promise<any>} */
function control(socket, request) {
  return new Promise((resolve, reject) => {
    let text = "";
    const connection = net.createConnection(socket);
    connection.setEncoding("utf8");
    connection.on("error", reject);
    connection.on("data", (chunk) => {
      text += chunk;
    });
    connection.on("end", () => resolve(JSON.parse(text)));
    connection.write(`${JSON.stringify(request)}\n`);
  });
}

test("a push the writer asks for after a successor took the issue is refused, with nothing pushed", async () => {
  const place = setUp(implementReplies(), {
    events: ["wait", ...IMPLEMENTOR_SESSION.events],
  });
  const owner = startJob(place, ["--stage", "implement", "--lane", "L"]);
  await waitFor("the writer session got its prompt", () =>
    piCommands(place).some(({ type }) => type === "prompt"),
  );
  const [claim] = logOf(place, "ops.log");
  const { PATH: searchPath } = process.env;
  const env = {
    ...process.env,
    ...Object.fromEntries([
      ["PATH", `${place.bin}${path.delimiter}${searchPath}`],
      ["ISSUE_PIPELINE_ROOT", place.root],
    ]),
  };
  const taken = spawnSync(process.execPath, [SUCCESSOR], {
    input: JSON.stringify(claim),
    encoding: "utf8",
    env,
  });
  assert.equal(taken.status, 0, taken.stderr);
  const { socket, launches } = statusOf(place);
  const { key } = launches.find(
    (/** @type {{ kind: string }} */ launch) => launch.kind === "session",
  );
  const push = await control(socket, {
    type: "push",
    key,
    execution: claim.execution,
  });
  assert.equal(push.pushed, "none");
  assert.match(String(push.pushError), LOST);
  assert.equal(fs.existsSync(path.join(place.runDir, "pushes.jsonl")), false);
  owner.child.kill("SIGTERM");
  await owner.end;
});
