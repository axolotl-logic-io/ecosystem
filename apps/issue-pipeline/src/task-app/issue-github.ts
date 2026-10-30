// One issue on GitHub as one account sees and changes it: its labels, its
// label timeline and its comments, and the label, comment and other writes
// a task run makes. Every write first rereads the issue's labels and refuses with
// Stopped while `agents:stop` is on it, unless the caller says the write is
// part of ending a run. Reads GitHub can repeat are retried through its
// transient failures; writes run once.
import { z } from "zod";
import { redactGhArgs } from "../github.ts";
import { credentialedRun } from "../github-auth.ts";
import { GH_TIMEOUT_MS, githubRead } from "../github-read.ts";
import { OpsError } from "../ops-error.ts";
import type { RunResult } from "../process.ts";
import { runFailure } from "../process.ts";
import {
  type Observation,
  observeAll,
  unreadable,
} from "../signals/github-source.ts";
import { STOP_LABEL, Stopped } from "./stopped.ts";

const NOT_FOUND = /\bHTTP 404\b/u;

const LABEL_EVENT = z.looseObject({
  id: z.number().int().positive(),
  event: z.string(),
  actor: z.looseObject({ login: z.string() }).nullable(),
  label: z.looseObject({ name: z.string() }).nullish(),
  created_at: z.string(),
});
const COMMENT = z.looseObject({
  id: z.number().int().positive(),
  body: z.string().nullable(),
  user: z.looseObject({ login: z.string() }).nullable(),
  created_at: z.string(),
});
const ISSUE = z.looseObject({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.string(),
  user: z.looseObject({ login: z.string() }).nullable(),
  labels: z.array(z.looseObject({ name: z.string() })),
});

// A label being added to or removed from the issue, by `actor`.
interface LabelEvent {
  id: number;
  kind: "labeled" | "unlabeled";
  label: string;
  actor: string | null;
  at: string;
}
interface IssueComment {
  id: number;
  author: string | null;
  body: string;
  at: string;
}
interface Issue {
  number: number;
  title: string;
  body: string;
  state: string;
  author: string | null;
  labels: string[];
}
// Where the issue is and who acts on it: `env` is the verified `gh`
// environment of `account`.
interface IssueRef {
  repo: string;
  number: number;
}
interface Actor {
  account: string;
  env: ReadonlyMap<string, string>;
}
// Whether a write belongs to ending a run, which `agents:stop` never holds.
interface WriteOptions {
  ending?: boolean;
}

function observed<T>(observation: Observation<T>, what: string): T {
  if (observation.status !== "ok") {
    throw new OpsError(`cannot read ${what}: ${unreadable(observation)}`);
  }
  return observation.value;
}

class IssueGitHub {
  readonly issue: IssueRef;
  readonly account: string;
  private readonly env: ReadonlyMap<string, string>;

  constructor(issue: IssueRef, actor: Actor) {
    this.issue = issue;
    this.account = actor.account;
    this.env = actor.env;
  }

  get path(): string {
    return `repos/${this.issue.repo}/issues/${this.issue.number}`;
  }

  // A `gh` read's whole result, retried through GitHub's transient
  // failures, for a caller that reads gh's exit status itself.
  readResult(args: readonly string[]): RunResult {
    return githubRead(() => this.gh(args)).result;
  }

  // A `gh` read, retried through GitHub's transient failures; null when
  // GitHub answers HTTP 404.
  read(args: readonly string[]): string | null {
    const result = this.readResult(args);
    if (result.code === 0) {
      return result.stdout;
    }
    if (NOT_FOUND.test(result.stderr)) {
      return null;
    }
    throw this.failure(args, result);
  }

  // A `gh` read printed as JSON, or null on HTTP 404.
  readJson(args: readonly string[]): unknown {
    const out = this.read(args);
    if (out === null || out.trim() === "") {
      return null;
    }
    return JSON.parse(out);
  }

  // Every row of the listing at `path`, or a thrown OpsError.
  list<S extends z.ZodType>(path: string, row: S): z.output<S>[] {
    return observed(observeAll(this.env, path, row), path);
  }

  issueNow(): Issue {
    const raw = ISSUE.parse(this.readJson(["api", this.path]));
    return {
      number: raw.number,
      title: raw.title,
      body: raw.body ?? "",
      state: raw.state,
      author: raw.user?.login ?? null,
      labels: raw.labels.map((label) => label.name),
    };
  }

  labels(): string[] {
    return this.issueNow().labels;
  }

  stopped(): boolean {
    return this.labels().includes(STOP_LABEL);
  }

  // Throws Stopped while `agents:stop` is on the issue.
  checkStop(): void {
    if (this.stopped()) {
      throw new Stopped();
    }
  }

  // The issue's label events, oldest first.
  labelEvents(): LabelEvent[] {
    return this.list(`${this.path}/events`, LABEL_EVENT).flatMap(
      (event): LabelEvent[] => {
        const label = event.label?.name;
        if (
          (event.event !== "labeled" && event.event !== "unlabeled") ||
          label === undefined
        ) {
          return [];
        }
        return [
          {
            id: event.id,
            kind: event.event,
            label,
            actor: event.actor?.login ?? null,
            at: event.created_at,
          },
        ];
      },
    );
  }

  comments(): IssueComment[] {
    return this.list(`${this.path}/comments`, COMMENT).map((comment) => ({
      id: comment.id,
      author: comment.user?.login ?? null,
      body: comment.body ?? "",
      at: comment.created_at,
    }));
  }

  // Removes `label`: "removed" when this call removed it, "absent" when it
  // wasn't on the issue.
  removeLabel(label: string, options: WriteOptions = {}): "removed" | "absent" {
    const args = [
      "api",
      "-X",
      "DELETE",
      `${this.path}/labels/${encodeURIComponent(label)}`,
    ];
    const result = this.write(args, options);
    if (result.code === 0) {
      return "removed";
    }
    if (NOT_FOUND.test(result.stderr)) {
      return "absent";
    }
    throw this.failure(args, result);
  }

  addLabel(label: string, options: WriteOptions = {}): void {
    const args = [
      "api",
      "-X",
      "POST",
      `${this.path}/labels`,
      "-f",
      `labels[]=${label}`,
    ];
    const result = this.write(args, options);
    if (result.code !== 0) {
      throw this.failure(args, result);
    }
  }

  comment(body: string, options: WriteOptions = {}): void {
    const args = [
      "api",
      "-X",
      "POST",
      `${this.path}/comments`,
      "-f",
      `body=${body}`,
    ];
    const result = this.write(args, options);
    if (result.code !== 0) {
      throw this.failure(args, result);
    }
  }

  // POSTs `input` as JSON to the repository API path `path`, such as a
  // pull request's reviews, and returns GitHub's answer.
  post(path: string, input: object, options: WriteOptions = {}): unknown {
    const args = ["api", "-X", "POST", path, "--input", "-"];
    const result = this.write(args, options, JSON.stringify(input));
    if (result.code !== 0) {
      throw this.failure(args, result);
    }
    const answer: unknown = JSON.parse(result.stdout);
    return answer;
  }

  // A `gh` write, run once, with its whole result, for a caller that reads
  // gh's exit status itself.
  writeResult(args: readonly string[], options: WriteOptions = {}): RunResult {
    return this.write(args, options);
  }

  // Posts a thread reply through the same stop boundary as other writes.
  reply(pull: number, comment: number, body: string): void {
    const args = [
      "api",
      "-X",
      "POST",
      `repos/${this.issue.repo}/pulls/${pull}/comments/${comment}/replies`,
      "-f",
      `body=${body}`,
    ];
    const result = this.write(args, {});
    if (result.code !== 0) {
      throw this.failure(args, result);
    }
  }

  // Runs a gh write once, after checking the issue's stop label.
  change(args: readonly string[], options: WriteOptions = {}): string {
    const result = this.write(args, options);
    if (result.code !== 0) {
      throw this.failure(args, result);
    }
    return result.stdout;
  }

  // Replaces the body of the issue's comment `id`.
  editComment(id: number, body: string, options: WriteOptions = {}): void {
    this.change(
      [
        "api",
        "-X",
        "PATCH",
        `repos/${this.issue.repo}/issues/comments/${id}`,
        "-f",
        `body=${body}`,
      ],
      options,
    );
  }

  private write(
    args: readonly string[],
    options: WriteOptions,
    input?: string,
  ): RunResult {
    if (options.ending !== true) {
      this.checkStop();
    }
    return this.gh(redactGhArgs(args), input);
  }

  private gh(args: readonly string[], input?: string): RunResult {
    const options: Parameters<typeof credentialedRun>[2] = {
      env: this.env,
      allowFail: true,
      timeoutMs: GH_TIMEOUT_MS,
    };
    if (input !== undefined) {
      options.input = input;
    }
    return credentialedRun("gh", args, options);
  }

  failure(args: readonly string[], result: RunResult): OpsError {
    const token = this.env.get("GH_TOKEN") ?? "";
    return new OpsError(
      runFailure("gh", redactGhArgs(args), result, {}).replaceAll(
        token,
        "<token>",
      ),
    );
  }
}

export type { Actor, Issue, IssueComment, IssueRef, LabelEvent, WriteOptions };
export { IssueGitHub };
