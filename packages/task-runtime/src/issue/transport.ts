import {
  type RunOptions,
  type RunResult,
  run,
  runFailure,
} from "../command.ts";
import { OpsError } from "../ops-error.ts";

function credentialedRun(
  cmd: string,
  args: readonly string[],
  options: RunOptions,
): RunResult {
  const token = options.env?.get("GH_TOKEN") ?? "";
  const result = run(cmd, args, { ...options, allowFail: true });
  const out = {
    ...result,
    stdout: result.stdout.replaceAll(token, "<token>"),
    stderr: result.stderr.replaceAll(token, "<token>"),
  };
  if (out.code !== 0 && options.allowFail !== true) {
    throw credentialFailure(cmd, args, out, options);
  }
  return out;
}

function credentialFailure(
  cmd: string,
  args: readonly string[],
  result: RunResult,
  options: RunOptions,
): OpsError {
  const token = options.env?.get("GH_TOKEN");
  const failure = runFailure(cmd, args, result, options);
  if (token === undefined) {
    return new OpsError(failure);
  }
  return new OpsError(failure.replaceAll(token, "<token>"));
}

export { credentialedRun, credentialFailure };
