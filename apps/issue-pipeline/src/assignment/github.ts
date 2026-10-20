import { z } from "zod";
import type { Config } from "../config.ts";
import { gh, ghJson, isAllowedUser } from "../github.ts";
import { OpsError } from "../ops-error.ts";
import { RetryHold, retryTime } from "./retry.ts";

interface Hub {
  read: (path: string) => unknown;
  create: (path: string, body: object, identity?: "dev" | "merge") => unknown;
  remove: (path: string) => void;
  allowed: (login: string) => boolean;
}
const PAGE_SIZE = 100;
const NOT_FOUND = /HTTP 404/u;
const HTTP =
  /^HTTP\/\S+ (?<status>\d+)[^\r\n]*\r?\n(?<headers>[\s\S]*?)\r?\n\r?\n(?<body>[\s\S]*)$/u;
const ERROR = z.looseObject({ message: z.literal("Not Found") });
function hubOf(cfg: Config): Hub {
  const prefix = `repos/${cfg.repo}/`;
  return {
    read: (endpoint: string): unknown => {
      const result = gh(
        cfg,
        "merge",
        ["api", "--include", `${prefix}${endpoint}`],
        { allowFail: true },
      );
      const {
        status,
        headers = "",
        body = "",
      } = HTTP.exec(result.stdout)?.groups ?? {};
      if (result.code !== 0) {
        if (status === "404" || NOT_FOUND.test(result.stderr)) {
          return null;
        }
        throw new RetryHold(result.stderr || "incomplete GitHub read", {
          until: retryTime(headers, Date.now()),
        });
      }
      if (status === undefined) {
        throw new OpsError("missing GitHub response envelope");
      }
      const value: unknown = JSON.parse(body);
      if (ERROR.safeParse(value).success) {
        return null;
      }
      return value;
    },
    create: (endpoint: string, body: object, identity = "merge"): unknown =>
      ghJson(
        cfg,
        identity,
        ["api", "-X", "POST", `${prefix}${endpoint}`, "--input", "-"],
        { input: JSON.stringify(body) },
      ),
    remove: (endpoint: string): void => {
      gh(cfg, "merge", ["api", "-X", "DELETE", `${prefix}${endpoint}`]);
    },
    allowed: (login: string): boolean => isAllowedUser(cfg, login),
  };
}

// A saturated budget is an incomplete observation, never an empty queue or
// evidence that an assignment, handoff or durable record disappeared.
function pages<T>(
  hub: Hub,
  endpoint: string,
  schema: z.ZodType<T>,
  budget: number,
): T[] {
  const rows: T[] = [];
  let separator = "?";
  if (endpoint.includes("?")) {
    separator = "&";
  }
  for (let page = 1; page <= budget; page += 1) {
    const batch = z
      .array(schema)
      .parse(
        hub.read(`${endpoint}${separator}per_page=${PAGE_SIZE}&page=${page}`),
      );
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) {
      return rows;
    }
  }
  throw new OpsError(
    `pagination budget exhausted for ${endpoint}; discovery incomplete`,
  );
}

export type { Hub };
export { hubOf, pages };
