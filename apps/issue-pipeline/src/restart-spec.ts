// A claim's restart check of the test and stub files the saved spec (or its
// full text in spec.md) documents, against the branch (src/spec-files.ts).

import fs from "node:fs";
import { gitIn } from "./git-state.ts";
import { missingSpecFiles } from "./spec-files.ts";
import type { State } from "./state.ts";

const STAMP_LENGTH = 16;

// The stages after spec, whose restart checks the spec's tests and stubs.
const AFTER_SPEC: ReadonlySet<unknown> = new Set([
  "implement",
  "open-pr",
  "review",
  "fix",
  "sync",
  "checks",
  "accept",
  "security",
  "merge",
]);

// The test and stub files the spec of a restart past spec documents that the
// commit checked out at `wt` lacks; none for a start at an earlier stage. The
// spec is read whole from spec.md when it was saved. Wiki pages, under
// `wikiDir`, are not checked: the code checkout never tracks them.
function specFilesMissing(wt: string, state: State, wikiDir: string): string[] {
  const { spec, specFile, files, stage } = state;
  if (!AFTER_SPEC.has(stage)) {
    return [];
  }
  let text = "";
  if (typeof spec === "string") {
    text = spec;
  }
  if (typeof specFile === "string" && fs.existsSync(specFile)) {
    text = fs.readFileSync(specFile, "utf8");
  }
  if (text === "") {
    return [];
  }
  const tracked = gitIn(wt, ["ls-tree", "-r", "--name-only", "HEAD"])
    .split("\n")
    .filter((path) => path !== "");
  return missingSpecFiles(text, files ?? [], tracked, wikiDir);
}

// What a restart's claim does with the files `missing` from the branch: a
// spec whose writer wrote its tests and stubs stops the issue (they are the
// spec writer's job, Axlog, 2026-10-16); any other spec's go to the
// implementer as unfinished work, noted in the issue's log.
function checkedSpecFiles(
  state: State,
  missing: readonly string[],
  now: Date,
): { state: State; specMissing: string[] } {
  const { unwrittenFiles: _cleared, ...rest } = state;
  if (missing.length === 0) {
    return { state: rest, specMissing: [] };
  }
  if (state.specWritesTests === true) {
    return { state: rest, specMissing: [...missing] };
  }
  const named = missing.map((file) => `\`${file}\``).join(", ");
  const at = `${now.toISOString().slice(0, STAMP_LENGTH)}Z`;
  const entry = `${at} restart: the spec documents files the branch lacks, left to the implementer: ${named}`;
  const log = [...(state.log ?? []), entry];
  return {
    state: { ...rest, unwrittenFiles: [...missing], log },
    specMissing: [],
  };
}

export { checkedSpecFiles, specFilesMissing };
