// @ts-check
// Private, exact-argv script. Unlisted reads and writes fail; there is no
// system gh, keyring, network or provider fallback.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { z } from "zod";
import { githubComment } from "./fake-gh.mjs";
import { batchAnswer, batchIds } from "./fake-graphql-batch.mjs";

const FAKE_IDENTITY = /^fake-pipeline-(?<identity>dev|merge)--(?<login>.+)$/u;
const COMMAND_TIMEOUT_MS = 20_000;
const SOURCE_REF = /^repos\/[^/]+\/[^/]+\/git\/refs\/heads\//u;
const UNEXPECTED_CALL = 91;
const STEP = z.object({
  args: z.array(z.string()),
  stdout: z.string().default(""),
  stderr: z.string().default(""),
  code: z.number().int().optional(),
  skipMutation: z.boolean().optional(),
  interrupt: z.boolean().default(false),
  updates: z.array(z.tuple([z.string(), z.string()])).default([]),
});
const SCRIPT = z.object({
  origin: z.string(),
  steps: z.array(STEP),
});
const { HOME: home } = process.env;
if (home === undefined) {
  throw new Error("fake gh needs its isolated home");
}
const file = path.join(home, "gh-script.json");
const script = SCRIPT.parse(JSON.parse(fs.readFileSync(file, "utf8")));
const args = process.argv.slice(2);
const { GH_TOKEN: ghToken } = process.env;
const tokenIdentity = FAKE_IDENTITY.exec(ghToken ?? "");
if (!tokenIdentity) {
  throw new Error("missing fake credential");
}
const { identity, login = "" } = tokenIdentity.groups ?? {};
if (args[0] === "api" && args[1] === "user") {
  process.stdout.write(login);
  process.exit(0);
}
let expectedIdentity = "merge";
if (
  args[0] === "pr" &&
  ["create", "edit", "reopen", "close", "ready"].includes(String(args[1]))
) {
  expectedIdentity = "dev";
}
if (
  args[0] === "api" &&
  args.includes("DELETE") &&
  args.some((arg) => SOURCE_REF.test(arg))
) {
  expectedIdentity = "dev";
}
if (identity !== expectedIdentity) {
  throw new Error("wrong fake credential identity");
}

// A bound ops child's ownership reads and the records an acquisition writes
// (fake-ownership.mjs, #169), kept out of the scripted calls.
const { serveOwnership } = createRequire(import.meta.url)(
  "./fake-ownership-gh.cjs",
);
const ownership = serveOwnership(home, args, login);
fs.appendFileSync(
  path.join(home, "gh-calls.jsonl"),
  `${JSON.stringify(args)}\n`,
);
const stateFile = path.join(path.dirname(script.origin), "state.json");
const body = fs.readFileSync(stateFile, "utf8");
const comment = githubComment({
  id: 900,
  body,
  login,
  created: "2026-01-01T00:00:00Z",
});
if (
  JSON.stringify(args) ===
  JSON.stringify([
    "api",
    "--paginate",
    "repos/example/repo/issues/7/comments?per_page=100",
    "--jq",
    ".[] | @json",
  ])
) {
  const records = ownership?.records ?? [];
  process.stdout.write(
    [comment, ...records].map((item) => JSON.stringify(item)).join("\n"),
  );
  process.exit(0);
}
const stateNode = {
  databaseId: 900,
  body,
  author: { login },
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  lastEditedAt: null,
  editor: null,
};
const batch = batchIds(args);
if (args[0] === "api" && args[1] === "graphql" && batch !== null) {
  const records = JSON.parse(
    fs.readFileSync(path.join(home, "ownership.json"), "utf8"),
  ).comments;
  /** @param {string} id */
  const nodeOf = (id) => {
    if (id === "comment-900") {
      return stateNode;
    }
    const item = records.find(
      (/** @type {{ node_id: string }} */ record) => record.node_id === id,
    );
    return {
      databaseId: item.id,
      body: item.body,
      author: item.user,
      createdAt: item.created_at,
      updatedAt: item.updated_at,
      lastEditedAt: null,
      editor: null,
    };
  };
  process.stdout.write(batchAnswer(batch, nodeOf));
  process.exit(0);
}
if (
  args[0] === "api" &&
  args[1] === "graphql" &&
  args.includes("id=comment-900")
) {
  process.stdout.write(
    JSON.stringify({
      data: {
        node: {
          databaseId: 900,
          body,
          author: { login },
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          lastEditedAt: null,
          editor: null,
        },
      },
    }),
  );
  process.exit(0);
}
const field = args.find((arg) => arg.startsWith("body=")) ?? "";
if (
  JSON.stringify(args) ===
  JSON.stringify([
    "api",
    "-X",
    "PATCH",
    "repos/example/repo/issues/comments/900",
    "-f",
    field,
    "--silent",
  ])
) {
  if (!field.startsWith("body=**🤖 issue-pipeline · state**")) {
    throw new Error("unsupported state body");
  }
  fs.writeFileSync(stateFile, field.slice("body=".length));
  process.exit(0);
}
const [step] = script.steps;
if (step === undefined || JSON.stringify(step.args) !== JSON.stringify(args)) {
  const methodAt = args.findIndex((arg) => arg === "-X" || arg === "--method");
  const method = args[methodAt + 1];
  if (
    args[0] === "api" &&
    method === "POST" &&
    args.includes("repos/example/repo/issues/50/comments") &&
    field.startsWith("body=")
  ) {
    process.exit(0);
  }
  process.stderr.write(`unexpected gh call: ${JSON.stringify(args)}\n`);
  process.exit(UNEXPECTED_CALL);
}
if (!script.origin.startsWith(`${home}${path.sep}`)) {
  throw new Error("fake gh refuses an origin outside its home");
}
if ((step.code ?? 0) === 0) {
  for (const [ref, sha] of step.updates) {
    execFileSync("git", ["-C", script.origin, "update-ref", ref, sha], {
      timeout: COMMAND_TIMEOUT_MS,
    });
  }
}
script.steps.shift();
fs.writeFileSync(file, JSON.stringify(script));
if (step.interrupt) {
  process.kill(process.ppid, "SIGKILL");
  process.exit(0);
}
process.stdout.write(step.stdout);
process.stderr.write(step.stderr);
process.exit(step.code ?? 0);
