// Per-test temporary repositories for slot ownership and maintenance outcomes.
import fs from "node:fs";
import "./isolated-root-test-kit.ts";
import type { Config } from "../src/config.ts";

const { testConfig }: typeof import("./config-test-kit.ts") = await import(
  "./config-test-kit.ts"
);
const { paths }: typeof import("../src/config.ts") = await import(
  "../src/config.ts"
);
const {
  checkoutEnvironment,
  withCheckoutSlot,
}: typeof import("../src/lane-slots.ts") = await import("../src/lane-slots.ts");

let cases = 0;

function config(extra: Record<string, unknown> = {}): Config {
  cases += 1;
  return testConfig({ repo: `lanes/case-${cases}`, laneSlots: 2, ...extra })
    .cfg;
}

function slot(cfg: Config, issue: number): string | undefined {
  return checkoutEnvironment(cfg, issue).get("ISSUE_PIPELINE_LANE_SLOT");
}

function occupy(cfg: Config, issue: number): string | undefined | null {
  return withCheckoutSlot(cfg, issue, () => {
    fs.mkdirSync(paths.worktree(cfg, issue), { recursive: true });
    return slot(cfg, issue);
  });
}

export { config, occupy, slot };
