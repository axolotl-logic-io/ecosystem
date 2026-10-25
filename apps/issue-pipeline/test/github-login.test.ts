import assert from "node:assert/strict";
import fs from "node:fs";
import { afterEach, mock, test } from "node:test";
import type { Config } from "../src/config.ts";
import { testConfig } from "./config-test-kit.ts";
import { credentialConfig } from "./credentials-test-kit.ts";
import { installFakeGh } from "./fake-gh.ts";
import { isolatedRoot } from "./isolated-root-test-kit.ts";

const { gh, git }: typeof import("../src/github.ts") = await import(
  "../src/github.ts"
);
const { githubRead }: typeof import("../src/github-read.ts") = await import(
  "../src/github-read.ts"
);
const { LOGIN_STDERR_LIMIT }: typeof import("../src/github-auth.ts") =
  await import("../src/github-auth.ts");
const fake = installFakeGh();
afterEach(() => mock.restoreAll());
const LOGIN = "api user --jq .login";
const WRITE = ["pr", "ready", "42"];
const FIRST_WAIT = 2000;
const SECOND_WAIT = 4000;
const THIRD_WAIT = 6000;
const BACKOFF: number[] = [FIRST_WAIT, SECOND_WAIT, THIRD_WAIT];
const ATTEMPTS = 4;
const FAILURE_STATUS = 17;
const BOUNDARY_OVERLAP = 5;
const FAIL = /unverifiable after 4 attempts/u;
const WRONG = /wrong account: observed @other-account/u;
const REJECTED = /authentication rejected \(HTTP 401\)/u;
const TRUNCATED = /\[truncated\]$/u;
const EMPTY = /stderr: <empty>$/u;
let sequence = 0;

function selected(identity: "dev" | "merge"): {
  cfg: Config;
  account: string;
  token: string;
} {
  sequence += 1;
  const account = `login-test-${sequence}`;
  const token = `fake-pipeline-${identity}--${account}`;
  const credentials = credentialConfig(account);
  if (identity === "dev") {
    credentials.devAccount = account;
    fs.writeFileSync(
      credentials.credentialsEnvFile,
      `ISSUE_PIPELINE_DEV_GITHUB_TOKEN=${token}\nISSUE_PIPELINE_MERGE_GITHUB_TOKEN=fake-pipeline-merge--merge-bot\n`,
    );
    credentials.mergeAccount = "merge-bot";
  }
  return { cfg: testConfig(credentials).cfg, account, token };
}

function waitsOf(): number[] {
  const waits: number[] = [];
  function wait(
    _array: Int32Array | BigInt64Array,
    _index: number,
    _value: number | bigint,
    ms: number,
  ): "timed-out" {
    waits.push(ms);
    return "timed-out";
  }
  mock.method(Atomics, "wait", wait);
  return waits;
}

for (const identity of ["dev", "merge"]) {
  if (identity !== "dev" && identity !== "merge") {
    throw new Error("invalid identity fixture");
  }
  for (const failure of ["HTTP 502"]) {
    test(`${identity} login recovers from ${failure} before one mutation`, () => {
      const waits = waitsOf();
      const { cfg, account } = selected(identity);
      fake.reply([
        { when: LOGIN, stderr: failure, code: 1 },
        { when: LOGIN, stdout: account },
        { when: "pr ready", keep: true },
      ]);
      // Fake gh requires development for PR writes. Merge exercises a comment write.
      let args = WRITE;
      if (identity === "merge") {
        args = ["api", "-X", "POST", "repos/example/repo/issues/7/comments"];
        fake.reply([
          { when: LOGIN, stderr: failure, code: 1 },
          { when: LOGIN, stdout: account },
          { when: "api -X POST", keep: true },
        ]);
      }
      gh(cfg, identity, args);
      assert.deepEqual(waits, [FIRST_WAIT]);
      assert.equal(fake.loginCalls().length, 2);
      assert.deepEqual(fake.calls().at(-1), args);
      assert.equal(
        fake.calls().filter((call) => call.join(" ") === args.join(" ")).length,
        1,
      );
      gh(cfg, identity, args);
      assert.equal(fake.loginCalls().length, 2, "success is cached");
    });
  }
}

test("a transport timeout uses the same bounded read policy", () => {
  const waits = waitsOf();
  const { attempts } = githubRead(() => ({
    code: 124,
    timedOut: true,
    stdout: "",
    stderr: "",
  }));
  assert.equal(attempts, ATTEMPTS);
  assert.deepEqual(waits, BACKOFF);
});

test("persistent failure is diagnostic, bounded, uncached and never runs the operation", () => {
  const waits = waitsOf();
  const { cfg, account, token } = selected("merge");
  fake.reply([
    {
      when: LOGIN,
      code: FAILURE_STATUS,
      stderr: `HTTP 503 ${token}`,
      keep: true,
    },
  ]);
  assert.throws(
    () => gh(cfg, "merge", WRITE),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, FAIL);
      assert.ok(error.message.includes(`merge; expected @${account}`));
      assert.ok(
        error.message.includes("gh exit status 17; stderr: HTTP 503 <token>"),
      );
      assert.equal(error.message.includes(token), false);
      return true;
    },
  );
  assert.equal(fake.loginCalls().length, ATTEMPTS);
  assert.deepEqual(waits, BACKOFF);
  fake.reply([{ when: LOGIN, code: 1, stderr: "HTTP 401" }]);
  assert.throws(() => gh(cfg, "merge", WRITE), REJECTED);
  assert.equal(
    fake.loginCalls().length,
    1,
    "failure never populates verification cache",
  );
});

for (const stderr of ["", "HTTP 503 secondary rate limit"]) {
  test(`a named wrong login takes precedence: ${stderr}`, () => {
    const waits = waitsOf();
    const { cfg } = selected("merge");
    let code = 0;
    if (stderr !== "") {
      code = 1;
    }
    fake.reply([{ when: LOGIN, code, stdout: "other-account", stderr }]);
    assert.throws(
      () => gh(cfg, "merge", WRITE),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, WRONG);
        assert.ok(error.message.includes(`gh exit status ${code}`));
        return true;
      },
    );
    assert.equal(fake.loginCalls().length, 1);
    assert.equal(fake.calls().length, 1);
    assert.deepEqual(waits, []);
  });
}

test("401 wins over transient text without inventing an observed login", () => {
  const waits = waitsOf();
  const { cfg, account } = selected("merge");
  fake.reply([
    { when: LOGIN, code: 1, stderr: "HTTP 401 HTTP 502 secondary rate limit" },
  ]);
  assert.throws(
    () => gh(cfg, "merge", WRITE),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, REJECTED);
      assert.ok(error.message.includes(`expected @${account}`));
      assert.equal(error.message.includes("wrong account"), false);
      return true;
    },
  );
  assert.deepEqual(waits, []);
  assert.equal(fake.loginCalls().length, 1);
});

test("malformed success and nontransient failures do not acquire retries", () => {
  const waits = waitsOf();
  for (const result of [
    { stdout: "null" },
    { stdout: "{malformed}" },
    { code: 1, stderr: "HTTP 403" },
  ]) {
    const { cfg } = selected("merge");
    fake.reply([{ when: LOGIN, ...result }]);
    assert.throws(() => gh(cfg, "merge", WRITE));
    assert.equal(fake.loginCalls().length, 1);
  }
  assert.deepEqual(waits, []);
});

test("stderr is redacted before truncation, including a token crossing the boundary", () => {
  const { cfg, token } = selected("merge");
  const padding = "x".repeat(
    LOGIN_STDERR_LIMIT - token.length - 1 - BOUNDARY_OVERLAP,
  );
  fake.reply([
    {
      when: LOGIN,
      code: 1,
      stderr: `${token} ${padding}${token}${"z".repeat(LOGIN_STDERR_LIMIT)}`,
    },
  ]);
  assert.throws(
    () => gh(cfg, "merge", WRITE),
    (error) => {
      assert.ok(error instanceof Error);
      const excerpt = error.message.split("; stderr: ")[1] ?? "";
      assert.equal(excerpt.length, LOGIN_STDERR_LIMIT);
      assert.match(excerpt, TRUNCATED);
      assert.ok(excerpt.startsWith("<token> "));
      assert.equal(excerpt.includes(token), false);
      assert.equal(excerpt.includes("fake-pipeline"), false);
      return true;
    },
  );
  const empty = selected("merge");
  fake.reply([{ when: LOGIN, code: 1 }]);
  assert.throws(() => gh(empty.cfg, "merge", WRITE), EMPTY);
});

test("credentialed git is gated by the same login verification", () => {
  const waits = waitsOf();
  const { cfg } = selected("dev");
  fake.reply([{ when: LOGIN, stderr: "HTTP 503", code: 1, keep: true }]);
  assert.throws(
    () =>
      git(cfg, "dev", ["ls-remote", "https://github.com/example/repo.git"], {
        cwd: isolatedRoot,
      }),
    FAIL,
  );
  assert.equal(fake.loginCalls().length, ATTEMPTS);
  assert.deepEqual(waits, BACKOFF);
});
