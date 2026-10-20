// @ts-check
// Shared fake GitHub, explicit invocations and create-only immutable refs.
import { createHash } from "node:crypto";
import { COMMENT } from "../src/comments.ts";
import { coordination } from "../src/coordination.ts";
import { assertReconciled, confirmedWrite } from "../src/execution.ts";
import { configFixture } from "./config-fixtures.mjs";
import { githubComment } from "./fake-gh.mjs";

/** @import { CoordinationPort } from "../src/coordination.ts" */
/** @import { IssueComment } from "../src/comments.ts" */
const SHA_WIDTH = 40;
const UUID_SUFFIX_WIDTH = 12;
const HEX = 16;
let nextIssue = 1000;
/** @param {string} label @returns {string} */
function instanceId(label) {
  return `00000000-0000-4000-8000-${createHash("sha256").update(label).digest("hex").slice(0, UUID_SUFFIX_WIDTH)}`;
}
class FakeGitHub {
  cfg = configFixture();
  /** @type {IssueComment[]} */
  comments = [];
  /** @type {Map<string, string>} */
  locks = new Map();
  /** @type {string[]} */
  writes = [];
  #token = 0;
  #seq = 0;
  #uncertain = "";
  #lost = "";
  /** @type {() => IssueComment[]} */
  #readComments = () => structuredClone(this.comments);
  /** @param {number} issue */
  constructor(issue) {
    this.issue = issue;
    /** @type {CoordinationPort} */
    this.port = {
      comments: () => {
        assertReconciled(this.cfg, issue);
        return this.#readComments();
      },
      append: (body) => {
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
      token: () => {
        this.#token += 1;
        return this.#token.toString(HEX).padStart(SHA_WIDTH, "0");
      },
      lock: (ref) => this.locks.get(ref) ?? null,
      reserve: (ref, value) => {
        if (this.locks.has(ref)) {
          throw new Error("422 ref already exists");
        }
        this.locks.set(ref, value);
      },
      write: (operation, write, confirmed, evidence) =>
        this.#write(operation, write, confirmed, evidence),
    };
  }
  /** @param {string} operation @param {() => void} write @param {() => boolean} confirmed @param {import('../src/coordination.ts').Evidence} [evidence] */
  #write(operation, write, confirmed, evidence) {
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
  /** @param {string} [instance] @param {string} [scope] @param {string} [lane] @param {number} [number] */
  guard(instance = "A", scope = "issue", lane = "lane", number = this.issue) {
    return coordination(this.cfg, this.port, scope, {
      ...this.identity(instance, lane, number),
    });
  }
  /** @param {string} instance @param {string} [lane] @param {number} [number] */
  identity(instance, lane = "lane", number = this.issue) {
    return {
      instance: instanceId(instance),
      lane,
      issue: number,
      branch: `work/issue-${number}`,
      repo: this.cfg.repo,
      base: this.cfg.baseBranch,
    };
  }
  /** @param {string} operation */
  uncertain(operation) {
    this.#uncertain = operation;
  }
  /** @param {string} operation */
  loseResponse(operation) {
    this.#lost = operation;
  }
  unreadable() {
    this.#readComments = () => {
      throw new Error("GitHub unavailable");
    };
  }
}
/** @returns {FakeGitHub} */
function world() {
  nextIssue += 1;
  return new FakeGitHub(nextIssue);
}

export { instanceId, world };
