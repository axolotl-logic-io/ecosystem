import { development, review } from "./candidates.ts";
import { DiscoveryHold } from "./hold.ts";
import type { DiscoveryReader } from "./reads.ts";
import { Reads, same } from "./reads.ts";
import type { Issue, Pull, Repository, Settings } from "./schema.ts";
import { ISSUE, PULL, SETTINGS } from "./schema.ts";
import type {
  Candidate,
  DiscoveryContext,
  DiscoveryPlan,
  WorkIdentity,
} from "./types.ts";
import { holdFor } from "./types.ts";

async function collect<T extends { number: number }>(
  context: DiscoveryContext,
  plan: DiscoveryPlan,
  listing: {
    path: string;
    schema: import("zod").z.ZodType<T>;
    candidates: (row: T) => Promise<void>;
  },
): Promise<void> {
  try {
    const rows = await context.reads.pages(
      context.repo.repo,
      listing.path,
      listing.schema,
    );
    if (new Set(rows.map((row) => row.number)).size !== rows.length) {
      throw new DiscoveryHold({
        reason: "page",
        evidence: listing.path,
        incomplete: true,
      });
    }
    for await (const row of rows) {
      await listing.candidates(row);
    }
  } catch (error) {
    plan.holds.push(
      holdFor(
        {
          repository: context.repo.repo,
          kind: "snapshot",
          number: null,
          login: null,
        },
        error,
      ),
    );
  }
}
async function offer(
  plan: DiscoveryPlan,
  work: WorkIdentity,
  candidate: () => Promise<Candidate>,
): Promise<void> {
  try {
    plan.candidates.push(await candidate());
  } catch (error) {
    plan.holds.push(holdFor(work, error));
  }
}
async function repositoryPlan(
  reads: Reads,
  settings: Settings,
  repo: Repository,
  plan: DiscoveryPlan,
): Promise<void> {
  const snapshot: WorkIdentity = {
    repository: repo.repo,
    kind: "snapshot",
    number: null,
    login: null,
  };
  if (
    !settings.allowRepositories.some((allowed) => same(allowed, repo.repo)) ||
    settings.repositories.filter((other) => same(other.repo, repo.repo))
      .length !== 1 ||
    same(repo.devAccount, repo.mergeAccount)
  ) {
    plan.holds.push(
      holdFor(
        snapshot,
        new DiscoveryHold({
          reason: "repository",
          evidence: "not-allowed-or-ambiguous",
        }),
      ),
    );
    return;
  }
  const context = { reads, settings, repo };
  await collect(context, plan, {
    path: `/repos/${repo.repo}/issues?state=open&assignee=*`,
    schema: ISSUE,
    candidates: async (issue: Issue): Promise<void> => {
      if (issue.pullRequest === undefined && issue.state === "open") {
        for await (const assignee of issue.assignees) {
          await offer(
            plan,
            {
              repository: repo.repo,
              kind: "issue",
              number: issue.number,
              login: assignee.login,
            },
            () => development(context, issue, assignee.login),
          );
        }
      }
    },
  });
  await collect(context, plan, {
    path: `/repos/${repo.repo}/pulls?state=open`,
    schema: PULL,
    candidates: async (pull: Pull): Promise<void> => {
      if (pull.state === "open") {
        for await (const reviewer of pull.requestedReviewers) {
          await offer(
            plan,
            {
              repository: repo.repo,
              kind: "pull",
              number: pull.number,
              login: reviewer.login,
            },
            () => review(context, pull, reviewer.login),
          );
        }
      }
    },
  });
}
// Explicit opt-in only. The injected reader is the trusted GitHub transport,
// not a source of preapproved booleans, saved authority or model role choices.
async function discoverAssignments(
  configuration: unknown,
  reader: DiscoveryReader,
): Promise<DiscoveryPlan> {
  const settings = SETTINGS.parse(configuration);
  const reads = new Reads(reader, settings.requestBudget);
  const plan: DiscoveryPlan = {
    executionAuthority: false,
    complete: true,
    requests: 0,
    candidates: [],
    holds: [],
    continuations: [],
  };
  for await (const repo of settings.repositories) {
    await repositoryPlan(reads, settings, repo, plan);
  }
  plan.requests = reads.count;
  plan.continuations = plan.holds.filter((hold) => hold.incomplete);
  plan.complete = plan.continuations.length === 0;
  return plan;
}

export type { DiscoveryReader, ReadRequest } from "./reads.ts";
export type { Candidate, DiscoveryPlan, Hold, WorkIdentity } from "./types.ts";
export { discoverAssignments };
