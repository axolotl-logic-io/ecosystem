// @ts-check
// Fake operator files, never process-wide dotenv loading or real tokens.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const directories = new Set();
process.on("exit", () => {
  for (const dir of directories) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** @param {string} [mergeAccount] @returns {{ devAccount: string, mergeAccount: string, credentialsEnvFile: string }} */
function credentialConfig(mergeAccount = "bot") {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "pipeline-fake-credentials-"),
  );
  directories.add(dir);
  const credentialsEnvFile = path.join(dir, "operator-credentials");
  fs.writeFileSync(
    credentialsEnvFile,
    `ISSUE_PIPELINE_DEV_GITHUB_TOKEN=fake-pipeline-dev--dev-bot\nISSUE_PIPELINE_MERGE_GITHUB_TOKEN=fake-pipeline-merge--${mergeAccount}\n`,
    { mode: 0o600 },
  );
  return { devAccount: "dev-bot", mergeAccount, credentialsEnvFile };
}

export { credentialConfig };
