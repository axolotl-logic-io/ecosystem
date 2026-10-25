// Local submodules for checkout tests; never enable file transport in production.
import { execFileSync } from "node:child_process";
import { setEnv } from "../ops-run-test-kit.ts";

function addSubmodule(parent: string, url: string, dir = "wiki"): void {
  setEnv("GIT_ALLOW_PROTOCOL", "file");
  execFileSync("git", ["-C", parent, "submodule", "add", "--quiet", url, dir]);
  execFileSync("git", [
    "-C",
    parent,
    "-c",
    "user.name=Seed",
    "-c",
    "user.email=seed@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    `Add ${dir} submodule`,
  ]);
}

export { addSubmodule };
