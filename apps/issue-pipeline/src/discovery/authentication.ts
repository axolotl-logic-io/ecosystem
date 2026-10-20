import { z } from "zod";
import { assertCommentAuthority } from "../comment-authority.ts";
import { isLegacyPipelineComment, isStateBody } from "../comment-marks.ts";
import type { IssueComment } from "../comments.ts";
import { COMMENT, pipelineRole } from "../comments.ts";
import { rawStateBody, readClaimState } from "../saved-state.ts";
import type { IssueState } from "../state.ts";
import { trustedInputBytes } from "../trusted-inputs.ts";
import { DiscoveryHold } from "./hold.ts";
import { type Reads, same } from "./reads.ts";
import type { Handoff, Issue, Repository, Worker } from "./schema.ts";
import {
  COMMENT_QUERY,
  COORDINATION,
  CURRENT_COMMENT,
  STRICT_STATE,
} from "./schema.ts";

const HTTP_OK = 200;
const HEX_RADIX = 16;
// Unlike the display reader, discovery cannot interpret omitted input fields
// as an anonymous author or an empty human requirement.
const INPUT_COMMENT = COMMENT.extend({
  body: COMMENT.shape.body.unwrap(),
  user: COMMENT.shape.user.unwrap(),
  id: COMMENT.shape.id.int().positive(),
});

interface Inputs {
  state: IssueState | null;
  handoff: Handoff | null;
  revision: string;
  comments: IssueComment[];
}

function workerFor(
  workers: readonly Worker[],
  repository: string,
  login: string,
  role: "development" | "review",
): Worker {
  const matches = workers.filter(
    (entry) => same(entry.repository, repository) && same(entry.login, login),
  );
  const [worker] = matches;
  if (
    matches.length !== 1 ||
    worker === undefined ||
    workers.some(
      (other) =>
        other !== worker &&
        same(other.repository, repository) &&
        same(other.worker, worker.worker),
    )
  ) {
    throw new DiscoveryHold({
      reason: "mapping",
      evidence: `${login}:${role}`,
    });
  }
  if (!worker.roles.includes(role)) {
    throw new DiscoveryHold({ reason: "role", evidence: `${login}:${role}` });
  }
  return worker;
}

async function human(
  reads: Reads,
  repo: Repository,
  login: string,
): Promise<boolean> {
  if (
    [repo.devAccount, repo.mergeAccount].some((bot) => same(bot, login)) ||
    !repo.allowedUsers.some((allowed) => same(allowed, login))
  ) {
    return false;
  }
  return await reads.collaborator(repo.repo, login);
}

async function commentsFor(
  reads: Reads,
  repo: Repository,
  number: number,
): Promise<IssueComment[]> {
  const path = `/repos/${repo.repo}/issues/${number}/comments`;
  const comments = await reads.pages(repo.repo, path, INPUT_COMMENT);
  const current: IssueComment[] = [];
  const seen = new Set<number>();
  for await (const item of comments) {
    if (seen.has(item.id)) {
      throw new DiscoveryHold({
        reason: "page",
        evidence: `${path}:${item.id}`,
        incomplete: true,
      });
    }
    seen.add(item.id);
    current.push(await verifiedComment(reads, repo, item));
  }
  return current.toSorted((a, b) => a.id - b.id);
}

async function verifiedComment(
  reads: Reads,
  repo: Repository,
  item: IssueComment,
): Promise<IssueComment> {
  if (!same(item.user?.login ?? "", repo.mergeAccount)) {
    return item;
  }
  if (item.node_id === undefined) {
    throw new DiscoveryHold({
      reason: "provenance",
      evidence: `comment:${item.id}`,
      incomplete: true,
    });
  }
  const reply = await reads.request({
    kind: "comment",
    repository: repo.repo,
    query: COMMENT_QUERY,
    id: item.node_id,
  });
  const parsed = CURRENT_COMMENT.safeParse(reply.body);
  const errors = z.object({ errors: z.unknown() }).safeParse(reply.body);
  if (
    reply.status !== HTTP_OK ||
    !parsed.success ||
    errors.success ||
    parsed.data.data.node.databaseId !== item.id
  ) {
    throw new DiscoveryHold({
      reason: "provenance",
      evidence: `comment:${item.id}`,
      incomplete: true,
    });
  }
  const { node } = parsed.data.data;
  const verified: IssueComment = {
    ...item,
    id: node.databaseId,
    body: node.body,
    user: node.author,
    lastEditedAt: node.lastEditedAt,
    editor: node.editor,
  };
  try {
    assertCommentAuthority(repo, verified);
  } catch (cause) {
    throw new DiscoveryHold(
      { reason: "provenance", evidence: `comment:${item.id}` },
      { cause },
    );
  }
  return verified;
}

function savedInputs(
  repo: Repository,
  number: number,
  comments: IssueComment[],
): Pick<Inputs, "state" | "handoff"> {
  try {
    const state = readClaimState(repo, number, comments);
    if (state === null) {
      if (
        comments.some(
          (item) =>
            same(item.user?.login ?? "", repo.mergeAccount) ||
            isLegacyPipelineComment(repo, item),
        )
      ) {
        throw new Error("prior pipeline work has no saved authority");
      }
      return { state, handoff: null };
    }
    const latest = comments
      .filter(
        (item) =>
          same(item.user?.login ?? "", repo.mergeAccount) &&
          isStateBody(item.body ?? ""),
      )
      .at(-1);
    const raw = rawStateBody(latest?.body ?? "");
    STRICT_STATE.parse(raw);
    const { coordination } = z
      .object({ coordination: COORDINATION.optional() })
      .parse(raw);
    if (
      coordination !== undefined &&
      (coordination.pending !== null || coordination.localRecovery)
    ) {
      throw new Error("unreconciled coordination");
    }
    return { state, handoff: coordination?.handoff ?? null };
  } catch (cause) {
    throw new DiscoveryHold(
      {
        reason: "state",
        evidence: `issue:${number}:reconciliation`,
        incomplete: false,
      },
      {
        cause,
      },
    );
  }
}

async function inputsFor(
  reads: Reads,
  repo: Repository,
  issue: Issue,
): Promise<Inputs> {
  if (!(await human(reads, repo, issue.user.login))) {
    throw new DiscoveryHold({
      reason: "provenance",
      evidence: `author:${issue.user.login}`,
    });
  }
  const comments = await commentsFor(reads, repo, issue.number);
  const saved = savedInputs(repo, issue.number, comments);
  const trusted: IssueComment[] = [];
  for await (const item of comments) {
    if (
      !isLegacyPipelineComment(repo, item) &&
      pipelineRole(repo, item) === null &&
      item.user?.login !== undefined &&
      (await human(reads, repo, item.user.login))
    ) {
      trusted.push(item);
    }
  }
  const bytes = new TextEncoder().encode(trustedInputBytes(issue, trusted));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const revision = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(HEX_RADIX).padStart(2, "0"),
  ).join("");
  return { ...saved, revision, comments };
}

export type { Inputs };
export { human, inputsFor, workerFor };
