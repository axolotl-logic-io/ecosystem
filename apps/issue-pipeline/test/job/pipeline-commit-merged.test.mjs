// @ts-check
// The credentialed socket must reject code independently of the tool scope.

import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { refOf } from "../job-git-test-kit.mjs";
import {
  BRANCH,
  git,
  headOf,
  ISSUE,
  KEY,
  openJob,
  pushesOf,
  write,
} from "../pipeline-commit-test-kit.mjs";
import { saveAuthority } from "../write-authority-test-kit.mjs";

const { newIssueState } = await import("../../src/state.ts");
const { closeJobCheckout } = await import("../../src/job/checkout-close.ts");
const { ensureClone } = await import("../../src/checkouts.ts");
const { withCheckout } = await import("../../src/config.ts");
const { pushOps } = await import("../../src/ops/push.ts");
const NO_BOUND_SCOPE = /no bound write scope/u;
const REFUSED_AUTHORITY = /write authority/u;
const SOCKET_REPLY = z.object({
  pushed: z.string(),
  pushError: z.string().nullable(),
});
const COMMIT_ENV = Object.fromEntries([["ISSUE_PIPELINE_COMMIT", "1"]]);
const RECOVERY_KEY = "implement-recovery";
const REFUSED_CODE = /code.*(?:merged|read.only|authority)/u;

/** @param {import("../../src/config.ts").Config} cfg @param {string} sha */
function saveMerged(cfg, sha) {
  saveAuthority(cfg, {
    ...newIssueState(ISSUE),
    branch: "agent/issue-7",
    stage: "implement",
    codeMerged: { pr: 42, sha },
  });
}

test("a saved merge refuses a stale writer's code and docs push and keeps them local", async () => {
  const job = await openJob("implement");
  try {
    const original = headOf(job.repo);
    git(job.origin, ["update-ref", BRANCH, original]);
    // The tool's launch scope still permits code, as does an attacker-forged scope.
    saveMerged(job.cfg, original);
    write(job.repo, "README.md", "unauthorized code\n");
    write(job.repo, "docs/Home.md", "unauthorized docs\n");
    const reply = await job.commit(["-am", "Mixed work"]);
    assert.equal(reply.details.pushed, "none");
    assert.match(reply.details.pushError, REFUSED_CODE);
    assert.notEqual(headOf(job.repo), original);
    assert.equal(refOf(job.origin, BRANCH), original);
    assert.deepEqual(pushesOf(job), []);
  } finally {
    job.close();
  }
});

test("a saved own-merge receipt closes code authority before claim sets codeMerged", async () => {
  const job = await openJob("implement");
  try {
    saveAuthority(job.cfg, {
      ...newIssueState(ISSUE),
      branch: "agent/issue-7",
      stage: "merge",
      merged: { code: headOf(job.repo), inputs: "trusted" },
      codeMerged: null,
    });
    write(job.repo, "README.md", "unauthorized\n");
    const reply = await job.commit(["-am", "Late work"]);
    assert.equal(reply.details.pushed, "none");
    assert.match(reply.details.pushError, REFUSED_CODE);
    assert.equal(refOf(job.origin, BRANCH), "");
  } finally {
    job.close();
  }
});

/** @param {string} socket @returns {Promise<z.infer<typeof SOCKET_REPLY>>} */
function forgedPush(socket) {
  return new Promise((resolve, reject) => {
    const connection = net.createConnection(socket);
    let text = "";
    connection.setEncoding("utf8");
    connection.on("error", reject);
    connection.on("data", (chunk) => {
      text += chunk;
    });
    connection.on("end", () => {
      resolve(SOCKET_REPLY.parse(JSON.parse(text)));
    });
    connection.write(
      `${JSON.stringify({ type: "push", key: KEY, state: { codeMerged: null }, scope: { repo: { access: "write" } } })}\n`,
    );
  });
}

test("a direct forged socket request cannot downgrade the freshly saved merge receipt", async () => {
  const job = await openJob("implement");
  try {
    saveMerged(job.cfg, headOf(job.repo));
    write(job.repo, "README.md", "local code\n");
    git(job.repo, ["commit", "-am", "Unauthorized direct commit"], COMMIT_ENV);
    const local = headOf(job.repo);
    const reply = await forgedPush(job.socket);
    assert.equal(reply.pushed, "none");
    assert.match(reply.pushError ?? "", REFUSED_CODE);
    assert.equal(refOf(job.origin, BRANCH), "");
    assert.equal(headOf(job.repo), local);
    ensureClone(job.cfg);
    const cfg = withCheckout(job.cfg, {
      issue: ISSUE,
      dir: job.repo,
      branch: job.branch,
    });
    // A forged op payload is not saved authority either.
    const operations = new Map(Object.entries(pushOps));
    for (const op of ["push", "exit-push"]) {
      const mutate = operations.get(op);
      assert.ok(mutate);
      assert.throws(() =>
        mutate(cfg, { number: ISSUE, state: { codeMerged: null } }),
      );
      assert.equal(refOf(job.origin, BRANCH), "");
    }
  } finally {
    job.close();
  }
});

const INVALID_AUTHORITIES = [
  null,
  { codeMerged: { pr: "broken", sha: "merged" } },
  { number: ISSUE + 1 },
  { merged: { code: "merged" } },
];
for (const [index, invalid] of INVALID_AUTHORITIES.entries()) {
  test(`invalid saved authority ${index} never permits socket code pushes`, async () => {
    const job = await openJob("implement");
    try {
      write(job.repo, "README.md", "local code\n");
      git(job.repo, ["commit", "-am", "Local code"], COMMIT_ENV);
      let state = null;
      if (invalid !== null) {
        state = {
          ...newIssueState(ISSUE),
          branch: job.branch,
          stage: "implement",
          ...invalid,
        };
      }
      saveAuthority(job.cfg, state);
      const reply = await forgedPush(job.socket);
      assert.equal(reply.pushed, "none");
      assert.match(reply.pushError ?? "", REFUSED_AUTHORITY);
      assert.equal(refOf(job.origin, BRANCH), "");
    } finally {
      job.close();
    }
  });
}

test("refused postmerge code survives teardown in a self-contained operator recovery bundle", async () => {
  const job = await openJob("implement");
  let local = "";
  try {
    saveMerged(job.cfg, headOf(job.repo));
    write(job.repo, "README.md", "recover this code\n");
    const reply = await job.commit(["-am", "Recovery work"]);
    assert.equal(reply.details.pushed, "none");
    local = headOf(job.repo);
  } finally {
    job.close();
  }
  await closeJobCheckout(
    job.cfg,
    ISSUE,
    {
      root: job.root,
      repo: job.repo,
      branch: job.branch,
      key: RECOVERY_KEY,
    },
    null,
  );
  assert.equal(fs.existsSync(job.root), false);
  assert.equal(refOf(job.origin, BRANCH), "");
  const bundle = path.join(
    job.runDir,
    "recovery",
    `${RECOVERY_KEY}-code.bundle`,
  );
  const restored = path.join(job.runDir, "restored-code");
  git(job.runDir, ["clone", bundle, restored]);
  assert.equal(headOf(restored), local);
  assert.equal(
    fs.readFileSync(path.join(restored, "README.md"), "utf8"),
    "recover this code\n",
  );
});

test("a receipt saved after socket entry but before the code push still refuses the mutation", async () => {
  const job = await openJob("implement");
  try {
    write(job.repo, "README.md", "late code\n");
    git(job.repo, ["commit", "-am", "Late code"], COMMIT_ENV);
    saveAuthority(
      job.cfg,
      {
        ...newIssueState(ISSUE),
        branch: job.branch,
        stage: "implement",
        codeMerged: { pr: 42, sha: "merged" },
      },
      true,
    );
    const reply = await forgedPush(job.socket);
    assert.equal(reply.pushed, "none");
    assert.match(reply.pushError ?? "", REFUSED_CODE);
    assert.equal(refOf(job.origin, BRANCH), "");
  } finally {
    job.close();
  }
});

test("commits true without a job-bound scope is not authorization, even with a forged writable tool environment", async () => {
  const job = await openJob("implement", { bindScope: false });
  try {
    write(job.repo, "README.md", "unbound code\n");
    const reply = await job.commit(["-am", "Unbound code"]);
    assert.equal(reply.details.pushed, "none");
    assert.match(reply.details.pushError, NO_BOUND_SCOPE);
    assert.equal(refOf(job.origin, BRANCH), "");
  } finally {
    job.close();
  }
});
