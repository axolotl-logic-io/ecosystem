// One extension, one tool. Each session owns its immutable query outputs and
// its successful delivery records. Neither reviewer prose nor END is coverage.
import { randomUUID } from "node:crypto";
import process from "node:process";
import { queryOf, REQUEST, ROOTS } from "./git-review-policy.ts";
import { executeGit, type GitEvidence } from "./git-review-process.ts";
import { repositoryOf, rootsOf } from "./git-review-repository.ts";

const MAX_RESULT_BYTES = 49_152;
const MAX_ERROR_LENGTH = 3000;
const MAX_PAGE_LINES = 1000;
const MAX_REQUEST_BYTES = 8192;
const LINE_BREAK = /\n/u;

interface Delivery {
  sessionId: string;
  queryId: string;
  repository: string;
  argv: string[];
  totalLines: number;
  exitCode: number;
  startLine: number | null;
  endLine: number | null;
}
interface Result {
  content: { type: "text"; text: string }[];
  details: Delivery | { error: string };
  isError?: boolean;
}
interface Cached {
  id: string;
  lines: string[];
  exitCode: number;
}
interface ReviewTool {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    id: string,
    params: unknown,
    signal?: AbortSignal,
  ) => Promise<Result>;
}
interface ExtensionApi {
  registerTool: (tool: ReviewTool) => void;
  on: (event: "session_start", handler: () => void) => unknown;
}

function linesOf(output: string): string[] {
  if (output === "") {
    return [];
  }
  const lines = output.split(LINE_BREAK);
  if (output.endsWith("\n")) {
    lines.pop();
  }
  return lines;
}

function resultOf(
  delivery: Delivery,
  lines: readonly string[],
  end: boolean,
): Result {
  let text = `${JSON.stringify(delivery)}\n${lines.join("\n")}`;
  if (end) {
    text += "\n=== END ===";
  }
  return { content: [{ type: "text", text }], details: delivery };
}

function pageOf(
  cached: Cached,
  identity: Omit<
    Delivery,
    "queryId" | "totalLines" | "exitCode" | "startLine" | "endLine"
  >,
  offset: number,
  limit: number,
): Result {
  const totalLines = cached.lines.length;
  if (totalLines > 0 && offset > totalLines) {
    throw new Error(`offset exceeds totalLines (${totalLines})`);
  }
  const delivery: Delivery = {
    ...identity,
    queryId: cached.id,
    totalLines,
    exitCode: cached.exitCode,
    startLine: null,
    endLine: null,
  };
  let result = resultOf(delivery, [], totalLines === 0);
  const lines: string[] = [];
  const count = Math.min(limit, MAX_PAGE_LINES, totalLines - offset + 1);
  for (let index = 0; index < count; index += 1) {
    const line = cached.lines[offset - 1 + index];
    if (line === undefined) {
      break;
    }
    lines.push(line);
    const candidate = resultOf(
      { ...delivery, startLine: offset, endLine: offset + index },
      lines,
      offset + index === totalLines,
    );
    if (Buffer.byteLength(JSON.stringify(candidate)) > MAX_RESULT_BYTES) {
      if (index === 0) {
        throw new Error(
          `Line ${offset} cannot fit intact in a tool result; no coverage recorded`,
        );
      }
      break;
    }
    result = candidate;
  }
  return result;
}

const TOOL_DEFINITION = {
  name: "git_review",
  label: "Git Review",
  description:
    "Read local Git evidence without shell, credentials or writes. cwd must equal an allowed repository root. argv starts with diff/show/log/rev-parse/merge-base/ls-tree/cat-file/status/blame/grep. Paths follow --; grep patterns follow -e. Only documented read-only options are supported. diff/status refuse initialized submodules; use show/log for committed evidence. offset is one-based; limit is capped at 1000 lines and 48 KiB including metadata. Same query is cached for this session. Details record exitCode and actual served ranges; combine ranges for the same sessionId/queryId to prove delivery. END alone is not coverage.",
  parameters: {
    type: "object",
    properties: {
      cwd: { type: "string" },
      argv: { type: "array", items: { type: "string" } },
      offset: { type: "integer", minimum: 1 },
      limit: { type: "integer", minimum: 1 },
    },
    required: ["cwd", "argv"],
    additionalProperties: false,
  },
};

// The allowlist is validated once per session, with no cwd/parent fallback.
// A rejected authority never becomes valid merely because a later call moves.
function reviewer(rootsJson: string | undefined): ReviewTool {
  const sessionId = randomUUID();
  const cache = new Map<string, Promise<Cached>>();
  let roots: string[] = [];
  let authorityError = "";
  try {
    roots = rootsOf(ROOTS.parse(JSON.parse(rootsJson ?? "null")));
  } catch {
    authorityError =
      "PI_GIT_REVIEW_ROOTS must be a nonempty JSON array of absolute local repository roots with plain .git directories";
  }
  return {
    ...TOOL_DEFINITION,
    execute: async (
      _id: string,
      params: unknown,
      signal?: AbortSignal,
    ): Promise<Result> => {
      try {
        if (authorityError !== "") {
          throw new Error(authorityError);
        }
        const request = REQUEST.parse(params);
        if (Buffer.byteLength(JSON.stringify(request)) > MAX_REQUEST_BYTES) {
          throw new Error("Query exceeds the 8192-byte request limit");
        }
        const query = queryOf(request.argv);
        const repository = repositoryOf(request.cwd, roots);
        const key = JSON.stringify([repository, request.argv]);
        let pending = cache.get(key);
        if (pending === undefined) {
          pending = executeGit(repository, query, signal).then(
            (evidence: GitEvidence): Cached => ({
              id: randomUUID(),
              lines: linesOf(evidence.output),
              exitCode: evidence.exitCode,
            }),
          );
          cache.set(key, pending);
          pending.catch((): void => {
            cache.delete(key);
          });
        }
        const cached = await pending;
        if (signal?.aborted) {
          throw new Error("Git review request aborted; no coverage recorded");
        }
        return pageOf(
          cached,
          { sessionId, repository, argv: request.argv },
          request.offset,
          request.limit,
        );
      } catch (error: unknown) {
        let message = "Git review refused";
        if (error instanceof Error) {
          message = error.message.slice(0, MAX_ERROR_LENGTH);
        }
        return {
          content: [{ type: "text", text: message }],
          details: { error: message },
          isError: true,
        };
      }
    },
  };
}

function gitReview(pi: ExtensionApi): void {
  pi.on("session_start", (): void => {
    const { PI_GIT_REVIEW_ROOTS: roots } = process.env;
    pi.registerTool(reviewer(roots));
  });
}

export type { Delivery, ExtensionApi, Result, ReviewTool };
export { MAX_RESULT_BYTES, reviewer };
export default gitReview;
