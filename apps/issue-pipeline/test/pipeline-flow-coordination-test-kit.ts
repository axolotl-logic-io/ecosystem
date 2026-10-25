// A prior run's released issue-execution history in the full-flow world
// (#167), for a test that seeds saved state: its request with a real token
// commit, the epoch ref that token reserved in the bare origin, its owner
// confirmation and its release, written as the coordination transport
// (src/execution.ts) writes them. The seeded state carries the receipt this
// returns, so the next job acquires after an authenticated release instead
// of adopting state no run owned. withoutCoordination is a world less what
// the coordination transport keeps in it, for a test that checks a refused
// job changed nothing else.
import { randomUUID } from "node:crypto";
import type { World } from "./fake-pipeline-flow-gh-world.ts";
import { gitIn } from "./fake-pipeline-flow-gh-world.ts";

const { bodyOf, refOf }: typeof import("../src/coordination-records.ts") =
  await import("../src/coordination-records.ts");

// Returns the record's comment id
function append(
  world: World,
  issue: number,
  record: Parameters<typeof bodyOf>[0],
): number {
  const id = world.nextId;
  world.comments.push({
    id,
    issue,
    login: world.account,
    createdAt: "2026-10-18T00:00:00Z",
    updatedAt: "2026-10-18T00:00:00Z",
    body: bodyOf(record),
  });
  world.nextId += 1;
  return id;
}

// Seeds a released run of issue `issue` on `branch`; returns its receipt.
function seedReleasedRun(
  world: World,
  issue: number,
  branch: string,
): { protocol: 1; request: number; instance: string } {
  const { repo, baseBranch: base, origin } = world;
  const scope = JSON.stringify([repo, base, "issue", issue, branch]);
  const instance = randomUUID();
  const head = gitIn(origin, ["rev-parse", `refs/heads/${base}`]);
  const tree = gitIn(origin, ["rev-parse", `${head}^{tree}`]);
  const message = `Pipeline coordination seed ${instance}`;
  const token = gitIn(origin, ["commit-tree", tree, "-p", head, "-m", message]);
  world.refs = { ...world.refs, [`refs/${refOf(scope, 0)}`]: token };
  const identity = { instance, lane: "seed", issue, branch, repo, base };
  const header: { version: 1; scope: string } = { version: 1, scope };
  const request = append(world, issue, {
    ...header,
    operation: randomUUID(),
    kind: "request",
    identity,
    token,
  });
  for (const kind of ["confirm", "release"] as const) {
    const operation = randomUUID();
    append(world, issue, { ...header, operation, kind, request, instance });
  }
  return { protocol: 1, request, instance };
}

const COORDINATION = "<!-- agent-pipeline:coordination\n";

function withoutCoordination(world: World): Omit<World, "refs" | "nextId"> {
  const { refs: _refs, nextId: _nextId, ...rest } = world;
  const comments = world.comments.filter(
    ({ body }) => !body.startsWith(COORDINATION),
  );
  return { ...rest, comments };
}

// Whether gh call `args` is one of the coordination transport's writes: a
// token commit, an epoch ref or a coordination record.
function isCoordinationWrite(args: readonly string[]): boolean {
  const route = args.find((arg) => arg.startsWith("repos/")) ?? "";
  return (
    route.endsWith("/git/commits") ||
    route.endsWith("/git/refs") ||
    args.some((arg) => arg.startsWith(`body=${COORDINATION}`))
  );
}

export { isCoordinationWrite, seedReleasedRun, withoutCoordination };
