// @ts-check
// A killed runtime cannot flush status or let checkout teardown catch up.
import fs from "node:fs";
import process from "node:process";
import { loadConfig, withCheckout } from "../src/config.ts";
import { pinIntegratedWiki } from "../src/ops/push.ts";
import { verify } from "../src/ops/verify.ts";
import { syncWiki } from "../src/wiki-publish.ts";

const ISSUE = 7;
const [config, repo, phase] = process.argv.slice(2);
if (config === undefined || repo === undefined || phase === undefined) {
  throw new Error("missing crash assignment");
}
const cfg = withCheckout(loadConfig(config), {
  issue: ISSUE,
  dir: repo,
  branch: "agent/issue-7",
});
const originalLink = fs.linkSync;
if (phase === "lost response") {
  fs.linkSync = (from, to) => {
    if (String(to).endsWith("completion.json")) {
      process.kill(process.pid, "SIGKILL");
    }
    originalLink(from, to);
  };
}
syncWiki(cfg, ISSUE, { lane: "L", job: "original-job" });
if (phase !== "after push" && phase !== "lost response") {
  pinIntegratedWiki(cfg, ISSUE);
}
if (phase === "during verify") {
  const interrupted = {
    ...cfg,
    commands: {
      ...cfg.commands,
      test: `${process.execPath} -e 'process.kill(${process.pid}, "SIGKILL")'`,
    },
  };
  verify(interrupted, { number: ISSUE });
}
process.kill(process.pid, "SIGKILL");
