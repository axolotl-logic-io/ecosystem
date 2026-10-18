// @ts-check
// The files an older install left that this version no longer has, and their
// retirement: install.mjs backs each one up, then removes it.

import fs from "node:fs";
import path from "node:path";

const STATUS_WIDTH = 8;

// Each retired file, relative to the pipeline root ("root") or to pi's agent
// folder ("agentDir"): the old workflow.js, which an old lane schedule could
// still run, the agents of the old stages and the old pi prompts.
/** @type {ReadonlyArray<{ under: "root" | "agentDir", file: string }>} */
const RETIRED = [
  { under: "root", file: "workflow.js" },
  {
    under: "agentDir",
    file: "agents/issue-pipeline/issue-pipeline-escalation.md",
  },
  { under: "agentDir", file: "agents/issue-pipeline/issue-pipeline-ops.md" },
  { under: "agentDir", file: "agents/issue-pipeline/issue-pipeline-reader.md" },
  {
    under: "agentDir",
    file: "agents/issue-pipeline/issue-pipeline-specifier.md",
  },
  { under: "agentDir", file: "agents/issue-pipeline/issue-pipeline-writer.md" },
  { under: "agentDir", file: "prompts/pipeline-start.md" },
  { under: "agentDir", file: "prompts/pipeline-pause.md" },
];

// Where `file`'s backup goes in the backup folder `backup`: under its own
// absolute path. Makes the folder it goes in.
/** @param {string} file @param {string} backup @returns {string} */
function backupPath(file, backup) {
  const copy = path.join(backup, path.relative(path.parse(file).root, file));
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  return copy;
}

/**
 * Lists each retired file present as `retired`, never one in `installed` and
 * never a folder, and unless `dryRun` copies it into `backup` and removes it.
 * Returns how many it lists.
 * @param {{
 *   root: string,
 *   agentDir: string,
 *   installed: ReadonlySet<string>,
 *   backup: string,
 *   dryRun: boolean,
 *   shown: (file: string) => string,
 * }} where
 * @returns {number}
 */
function retireOldFiles({ root, agentDir, installed, backup, dryRun, shown }) {
  const present = RETIRED.map(({ under, file }) => {
    if (under === "root") {
      return path.join(root, file);
    }
    return path.join(agentDir, file);
  }).filter(
    (file) =>
      !installed.has(file) &&
      fs.existsSync(file) &&
      fs.lstatSync(file).isFile(),
  );
  for (const file of present) {
    console.log(`${"retired".padEnd(STATUS_WIDTH)} ${shown(file)}`);
    if (!dryRun) {
      fs.copyFileSync(file, backupPath(file, backup));
      fs.rmSync(file);
    }
  }
  return present.length;
}

export { backupPath, retireOldFiles };
