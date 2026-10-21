// @ts-check
// Per-test temporary repositories for slot ownership and maintenance outcomes.
import fs from "node:fs";
import "./isolated-root-test-kit.mjs";

const { testConfig } = await import("./config-test-kit.mjs");
const { paths } = await import("../src/config.ts");
const { checkoutEnvironment, withCheckoutSlot } = await import(
  "../src/lane-slots.ts"
);
/** @import { Config } from "../src/config.ts" */
let cases = 0;

/** @param {Record<string, unknown>} [extra] @returns {Config} */
function config(extra = {}) {
  cases += 1;
  return testConfig({ repo: `lanes/case-${cases}`, laneSlots: 2, ...extra })
    .cfg;
}

/** @param {Config} cfg @param {number} issue @returns {string | undefined} */
function slot(cfg, issue) {
  return checkoutEnvironment(cfg, issue).get("ISSUE_PIPELINE_LANE_SLOT");
}

/** @param {Config} cfg @param {number} issue @returns {string | undefined | null} */
function occupy(cfg, issue) {
  return withCheckoutSlot(cfg, issue, () => {
    fs.mkdirSync(paths.worktree(cfg, issue), { recursive: true });
    return slot(cfg, issue);
  });
}

export { config, occupy, slot };
