// Local mirrors may mediate a retained checkout's configured remote identity.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { gitText } from "./adoption-preservation.ts";
import type { Config } from "./config.ts";
import { wikiCfg } from "./config.ts";
import { git } from "./github.ts";
import { OpsError } from "./ops-error.ts";

const SHA = z.string().regex(/^[a-f0-9]{40}$/u);
const PATH_LINE = /^(?<key>submodule\..*)\.path (?<value>.*)$/u;

function remoteRef(cfg: Config, url: string, branch: string): string | null {
  const result = git(cfg, "dev", [
    "ls-remote",
    "--refs",
    url,
    `refs/heads/${branch}`,
  ]).stdout.trim();
  if (result === "") {
    return null;
  }
  const rows = result.split("\n");
  const [sha, ref] = (rows[0] ?? "").split("\t");
  if (rows.length !== 1 || ref !== `refs/heads/${branch}`) {
    throw new OpsError(`unreadable remote branch identity for ${branch}`);
  }
  return SHA.parse(sha);
}

function localOrigin(url: string): string | null {
  if (url.startsWith("file://")) {
    return fileURLToPath(url);
  }
  if (path.isAbsolute(url)) {
    return url;
  }
  return null;
}

// A retained job may point through a local mirror. Follow only local origins;
// never accept a different network repository as the configured repository.
function assertOrigin(dir: string, expected: string): void {
  try {
    let origin = gitText(dir, ["remote", "get-url", "origin"]);
    const seen = new Set<string>();
    while (origin !== expected) {
      const local = localOrigin(origin);
      if (local === null || seen.has(local)) {
        throw new OpsError(`retained origin identity mismatch in ${dir}`);
      }
      seen.add(local);
      const configuredLocal = localOrigin(expected);
      if (
        configuredLocal !== null &&
        fs.realpathSync(local) === fs.realpathSync(configuredLocal)
      ) {
        return;
      }
      origin = gitText(local, ["remote", "get-url", "origin"]);
    }
  } catch (error) {
    throw new OpsError(
      `retained origin identity mismatch or unreadable mirror chain in ${dir}`,
      { cause: error },
    );
  }
}

function wikiOrigin(cfg: Config, code: string): string {
  if (localOrigin(cfg.cloneUrl || "") === null) {
    return `https://github.com/${cfg.repo}.wiki.git`;
  }
  const rows = gitText(code, [
    "config",
    "--blob",
    "HEAD:.gitmodules",
    "--get-regexp",
    "^submodule\\..*\\.path$",
  ]).split("\n");
  const keys = rows.flatMap((row) => {
    const { key, value } = PATH_LINE.exec(row)?.groups ?? {};
    if (value === wikiCfg(cfg)?.dir && key !== undefined) {
      return [key];
    }
    return [];
  });
  const [key] = keys;
  if (keys.length !== 1 || key === undefined) {
    throw new OpsError("configured local wiki identity is ambiguous");
  }
  const url = gitText(code, [
    "config",
    "--blob",
    "HEAD:.gitmodules",
    "--get",
    `${key}.url`,
  ]);
  if (localOrigin(url) === null) {
    throw new OpsError(
      "local configured repository requires a local wiki origin",
    );
  }
  return url;
}

export { assertOrigin, remoteRef, wikiOrigin };
