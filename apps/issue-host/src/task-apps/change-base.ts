import { run as runCommand } from "../process.ts";

function changeBase(dir: string, target: string, code: string): string {
  const base = runCommand("git", ["-C", dir, "merge-base", target, code], {
    allowFail: true,
  });
  if (base.code !== 0) {
    return target;
  }
  return base.stdout.trim();
}

export { changeBase };
