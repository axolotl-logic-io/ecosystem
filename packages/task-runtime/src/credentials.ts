import fs from "node:fs";
import { parseEnv } from "node:util";
import { OpsError } from "./ops-error.ts";

const TOKEN = /^\S+$/u;
const NON_OWNER_PERMISSION_RANGE = 0o100;

// The token `variable` sets in the operator's private credential file
// `file`, read alone and never exported. `name` says which credential it is
// in errors, which never show the file's path or contents.
function readCredential(file: string, variable: string, name: string): string {
  let contents: string | null = null;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.mode % NON_OWNER_PERMISSION_RANGE !== 0) {
      throw new OpsError("credential file must be private to its owner");
    }
    contents = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error instanceof OpsError) {
      throw error;
    }
    contents = null;
  }
  if (contents === null) {
    throw new OpsError(`cannot read the configured ${name} credential file`);
  }
  const values = new Map(Object.entries(parseEnv(contents)));
  const selected = values.get(variable);
  if (selected === undefined || !TOKEN.test(selected)) {
    throw new OpsError(
      `credential file must set ${variable} to a nonempty token`,
    );
  }
  return selected;
}

export { readCredential };
