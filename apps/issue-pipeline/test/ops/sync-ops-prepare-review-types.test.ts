// A type change must classify both sides before choosing to read head text.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { isolatedOpsFixture } from "../integration-source-test-kit.ts";
import type { OpsFixture } from "../ops-fixtures.ts";
import {
  baseGitlink,
  NEW_COMMIT,
  OLD_COMMIT,
  prepare,
  setGitlink,
  startBranch,
} from "./gitlink-review-test-kit.ts";

const fx: OpsFixture = await isolatedOpsFixture("review-types");
const FIRST_ISSUE = 201;
const FILE = "module with\ttab";
const CONTENT = "ordinary file content must not be appended for a type change";

for (const toGitlink of [false, true]) {
  test(`gitlink type change to gitlink = ${toGitlink} keeps both object kinds path-only`, () => {
    const n = FIRST_ISSUE + Number(toGitlink);
    if (toGitlink) {
      const seed = path.join(fx.root, "seed");
      fx.sh(`git -C ${seed} pull -q origin integration`);
      fs.rmSync(path.join(seed, FILE), { recursive: true, force: true });
      fs.writeFileSync(path.join(seed, FILE), CONTENT);
      fx.sh(`git -C ${seed} add '${FILE}'`);
      fx.sh(
        `git -C ${seed} commit -qm blob && git -C ${seed} push -q origin integration`,
      );
    } else {
      baseGitlink(fx, OLD_COMMIT, FILE);
    }
    startBranch(fx, n, "marker", `case ${n}`);
    const wt = fx.worktree(n);
    let blob: string;
    if (toGitlink) {
      blob = fx.sh(`git -C ${wt} rev-parse 'HEAD:${FILE}'`);
      fs.unlinkSync(path.join(wt, FILE));
      setGitlink(fx, wt, FILE, NEW_COMMIT);
    } else {
      fs.rmSync(path.join(wt, FILE), { recursive: true, force: true });
      fs.writeFileSync(path.join(wt, FILE), CONTENT);
      fx.sh(`git -C ${wt} add '${FILE}'`);
      blob = fx.sh(`git -C ${wt} rev-parse ':${FILE}'`);
    }
    fx.sh(`git -C ${wt} commit -q --allow-empty -m 'type change'`);
    let oldSide = `commit \`${OLD_COMMIT}\``;
    let newSide = `blob \`${blob}\``;
    if (toGitlink) {
      oldSide = `blob \`${blob}\``;
      newSide = `commit \`${NEW_COMMIT}\``;
    }
    const { files } = prepare(fx, n);
    assert.ok(
      files.includes(
        `\n## ${FILE}\n\nGitlink: path only. Old: ${oldSide}; new: ${newSide}.\n`,
      ),
    );
    assert.ok(!files.includes(CONTENT));
  });
}
