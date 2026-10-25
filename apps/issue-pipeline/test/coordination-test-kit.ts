// Shared fake GitHub, explicit invocations and create-only immutable refs.
import { createHash } from "node:crypto";
import type { IssueComment } from "../src/comments.ts";
import { COMMENT } from "../src/comments.ts";
import type { CoordinationPort, Evidence } from "../src/coordination.ts";
import { coordination } from "../src/coordination.ts";
import {
  assertReconciled,
  confirmedWrite,
} from "../src/coordination-journal.ts";
import { scopeOf } from "../src/coordination-records.ts";
import { configFixture } from "./config-fixtures.ts";
import { githubComment } from "./fake-gh.ts";

const SHA_WIDTH = 40;
const UUID_SUFFIX_WIDTH = 12;
const HEX = 16;
let nextIssue = 1000;
function instanceId(label: string): string {
  return `00000000-0000-4000-8000-${createHash("sha256").update(label).digest("hex").slice(0, UUID_SUFFIX_WIDTH)}`;
}
class FakeGitHub {
  issue: number;
  port: CoordinationPort;
  cfg = configFixture();
  comments: IssueComment[] = [];
  locks: Map<string, string> = new Map();
  writes: string[] = [];
  #token = 0;
  #seq = 0;
  #uncertain = "";
  #lost = "";
  #readComments: () => IssueComment[] = (): IssueComment[] =>
    structuredClone(this.comments);
  constructor(issue: number) {
    this.issue = issue;
    this.port = {
      comments: (): IssueComment[] => {
        assertReconciled(this.cfg, issue);
        return this.#readComments();
      },
      append: (body: string): void => {
        this.#seq += 1;
        this.comments.push(
          COMMENT.parse(
            githubComment({
              id: this.#seq,
              body,
              login: this.cfg.mergeAccount,
              created: "2000-01-01T00:00:00Z",
            }),
          ),
        );
      },
      token: (): string => {
        this.#token += 1;
        return this.#token.toString(HEX).padStart(SHA_WIDTH, "0");
      },
      lock: (ref: string): string | null => this.locks.get(ref) ?? null,
      reserve: (ref: string, value: string): void => {
        if (this.locks.has(ref)) {
          throw new Error("422 ref already exists");
        }
        this.locks.set(ref, value);
      },
      write: (
        operation: string,
        write: () => void,
        confirmed: () => boolean,
        evidence?: Evidence,
      ): void => this.#write(operation, write, confirmed, evidence),
    };
  }
  #write(
    operation: string,
    write: () => void,
    confirmed: () => boolean,
    evidence?: Evidence,
  ): void {
    confirmedWrite(this.cfg, this.issue, operation, {
      write: () => {
        this.writes.push(operation);
        write();
        if (this.#lost === operation) {
          throw new Error("lost response");
        }
      },
      confirmed: () => this.#uncertain !== operation && confirmed(),
      evidence: evidence ?? null,
    });
  }
  guard(
    instance = "A",
    scope = "issue",
    lane = "lane",
    number: number = this.issue,
  ): ReturnType<typeof coordination> {
    return coordination(this.cfg, this.port, this.scope(scope, number), {
      ...this.identity(instance, lane, number),
    });
  }
  scope(kind = "issue", number: number = this.issue): string {
    if (kind === "issue") {
      return scopeOf(this.identity("A", "lane", number), "issue");
    }
    return scopeOf(this.identity("A", "lane", number), "integration");
  }
  identity(
    instance: string,
    lane = "lane",
    number: number = this.issue,
  ): {
    instance: string;
    lane: string;
    issue: number;
    branch: string;
    repo: string;
    base: string;
  } {
    return {
      instance: instanceId(instance),
      lane,
      issue: number,
      branch: `work/issue-${number}`,
      repo: this.cfg.repo,
      base: this.cfg.baseBranch,
    };
  }
  uncertain(operation: string): void {
    this.#uncertain = operation;
  }
  loseResponse(operation: string): void {
    this.#lost = operation;
  }
  unreadable(): void {
    this.#readComments = (): never => {
      throw new Error("GitHub unavailable");
    };
  }
}
function world(): FakeGitHub {
  nextIssue += 1;
  return new FakeGitHub(nextIssue);
}

export { instanceId, world };
