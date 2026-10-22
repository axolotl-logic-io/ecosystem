import { z } from "zod";
import { collect } from "./collection.ts";
import type { Config } from "./config.ts";
import { errorMessage } from "./errors.ts";
import { exec } from "./process-observations.ts";
import { parse } from "./source-records.ts";

const cacheMilliseconds = 120_000;
const listTimeout = 20_000;
const mainTimeout = 15_000;
const threadTimeout = 30_000;
const listReadBytes = 1_048_576;
const mainReadBytes = 8192;
const threadReadBytes = 262_144;
const errorPreviewCharacters = 180;
const githubItemSchema = z.object({
  repo: z.string(),
  number: z.number().int().positive(),
  title: z.string(),
  labels: z.array(z.object({ name: z.string() })).optional(),
  headRefOid: z.string().optional(),
  state: z.string().optional(),
  isPr: z.boolean().optional(),
});
const listSchema = z.array(githubItemSchema.omit({ repo: true }));
type GitHubItem = z.infer<typeof githubItemSchema>;
type ReadCommand = (
  command: string,
  args: string[],
  options: { timeout: number; maxBuffer: number },
) => Promise<{ stdout: string }>;
type ItemKind = "issue" | "pr";
interface GitHubBatch {
  kind: ItemKind;
  items: GitHubItem[];
  error?: string;
}

class Remote {
  readonly config: Config;
  private readonly command: ReadCommand;
  private readonly now: () => number;
  at = 0;
  private mainAt = 0;
  main = "unknown";
  issues: GitHubItem[] = [];
  prs: GitHubItem[] = [];
  errors: string[] = [];
  inflight: Promise<void> | undefined;
  constructor(
    config: Config,
    command: ReadCommand = exec,
    now: () => number = Date.now,
  ) {
    this.config = config;
    this.command = command;
    this.now = now;
  }
  refresh(): Promise<void> {
    if (this.inflight !== undefined) {
      return this.inflight;
    }
    if (this.now() - this.at < cacheMilliseconds) {
      return Promise.resolve();
    }
    this.at = this.now();
    this.inflight = this.fetch().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }
  private async list(repo: string, kind: ItemKind): Promise<GitHubBatch> {
    let fields = "number,title,headRefOid,state";
    if (kind === "issue") {
      fields = "number,title,labels,state";
    }
    try {
      const result = await this.command(
        "gh",
        [
          kind,
          "list",
          "-R",
          repo,
          "--state",
          "open",
          "--limit",
          "100",
          "--json",
          fields,
        ],
        { timeout: listTimeout, maxBuffer: listReadBytes },
      );
      const items = listSchema
        .parse(parse(result.stdout))
        .filter(
          (item) =>
            !(
              kind === "issue" &&
              repo.endsWith("/ecosystem") &&
              item.title.startsWith("ops: migrate")
            ),
        )
        .map((item) => ({ ...item, repo }));
      return { kind, items };
    } catch (error) {
      return {
        kind,
        items: [],
        error: `${repo} ${kind}: ${errorMessage(error).slice(0, errorPreviewCharacters)}`,
      };
    }
  }
  private async fetch(): Promise<void> {
    const requests = this.config.repos.flatMap(
      (repo): { repo: string; kind: ItemKind }[] => [
        { repo, kind: "issue" },
        { repo, kind: "pr" },
      ],
    );
    const batches = await collect(requests, ({ repo, kind }) =>
      this.list(repo, kind),
    );
    this.issues = batches
      .filter((batch) => batch.kind === "issue")
      .flatMap((batch) => batch.items);
    this.prs = batches
      .filter((batch) => batch.kind === "pr")
      .flatMap((batch) => batch.items);
    this.errors = batches.flatMap((batch) => {
      if (batch.error !== undefined) {
        return [batch.error];
      }
      return [];
    });
    await this.refreshMain();
  }
  private async refreshMain(): Promise<void> {
    if (this.now() - this.mainAt >= cacheMilliseconds) {
      this.mainAt = this.now();
      try {
        const result = await this.command(
          "gh",
          ["api", `repos/${this.config.mainRepo}/commits/main`, "--jq", ".sha"],
          { timeout: mainTimeout, maxBuffer: mainReadBytes },
        );
        this.main = result.stdout.trim();
      } catch {
        this.main = "unavailable";
      }
    }
  }
  async thread(repo: string, number: number): Promise<string> {
    if (
      !(this.config.repos.includes(repo) && Number.isSafeInteger(number)) ||
      number <= 0
    ) {
      throw new Error("Invalid issue");
    }
    const result = await this.command(
      "gh-thread",
      [String(number), "-R", repo],
      { timeout: threadTimeout, maxBuffer: threadReadBytes },
    );
    return result.stdout;
  }
}

export type { GitHubItem, ReadCommand };
export { cacheMilliseconds, githubItemSchema, Remote };
