// Compatibility repository-config reader; shared observations require explicit authority.
import {
  observeAll as list,
  type Observation,
  observeOne as one,
} from "@ecosystem/task-runtime/issue/github-observation";
import type { z } from "zod";
import type { Config } from "./config.ts";
import { authenticatedEnv } from "./github-auth.ts";

type Reader = Config | ReadonlyMap<string, string>;
function isEnvironment(reader: Reader): reader is ReadonlyMap<string, string> {
  return reader instanceof Map;
}
function authority(
  reader: Reader,
): ReadonlyMap<string, string> | (() => ReadonlyMap<string, string>) {
  if (isEnvironment(reader)) {
    return reader;
  }
  // The configured reader is validated by its existing config boundary.
  return (): ReadonlyMap<string, string> => authenticatedEnv(reader, "landing");
}
function observeAll<S extends z.ZodType>(
  reader: Reader,
  path: string,
  row: S,
): Observation<z.output<S>[]> {
  return list(authority(reader), path, row);
}
function observeOne<S extends z.ZodType>(
  reader: Reader,
  path: string,
  schema: S,
): Observation<z.output<S>> {
  return one(authority(reader), path, schema);
}

export type { Reader };
export { observeAll, observeOne };
