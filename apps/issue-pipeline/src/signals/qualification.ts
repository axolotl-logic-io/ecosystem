// Human signal qualification (`signal-authority`): the producer must be a
// person, not a configured pipeline account, a bot or a GitHub App, and a
// current active member of the explicitly configured organization, checked
// by durable user id. Every check is a fresh read. A reader that can't prove
// its own active membership qualifies nobody, and an unreadable answer is
// unknown, never "not a member".
import { z } from "zod";
import type { Config } from "../config.ts";
import { wire } from "../discovery/wire.ts";
import type { HumanProvenance } from "../domain.ts";
import { observeOne } from "./github-source.ts";

// Who an issue event names as its actor, and whether a GitHub App performed
// it on their behalf.
interface EventActor {
  login: string;
  id: number;
  type: string;
  viaApp: boolean;
}

type Qualification =
  | { status: "qualified"; provenance: HumanProvenance }
  // A complete, affirmative answer that the producer can't qualify.
  | { status: "rejected"; reason: string }
  | { status: "unknown"; reason: string };

const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;
const BOT_LOGIN = /\[bot\]$/iu;
const ORGANIZATION_URL =
  /^https:\/\/api\.github\.com\/orgs\/(?<organization>[^/]+)$/u;
const MEMBER_ROLES: readonly string[] = ["admin", "member"];
// GitHub's org-membership schema (GET /orgs/{org}/memberships/{username} and
// GET /user/memberships/orgs/{org}). `organization_url` is required;
// `organization` may be absent, and must agree when present.
const MEMBERSHIP = wire(
  z.looseObject({
    state: z.enum(["active", "pending"]),
    role: z.string(),
    organizationUrl: z.string(),
    organization: z.looseObject({ login: z.string() }).nullish(),
    user: z
      .looseObject({ login: z.string(), id: z.number().int().positive() })
      .nullable(),
  }),
);
const USER = wire(
  z.looseObject({
    login: z.string().regex(GITHUB_LOGIN),
    id: z.number().int().positive(),
    type: z.string(),
  }),
);

type Membership = z.infer<typeof MEMBERSHIP>;

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function unknown(reason: string): Qualification {
  return { status: "unknown", reason };
}

function rejected(reason: string): Qualification {
  return { status: "rejected", reason };
}

// Why `actor` is a machine whose labels grant nothing, or null for a person.
function machineReason(cfg: Config, actor: EventActor): string | null {
  const accounts = [cfg.devAccount, cfg.landingAccount, cfg.legacyAccount];
  if (actor.viaApp) {
    return `@${actor.login} acted through a GitHub App`;
  }
  if (actor.type !== "User" || BOT_LOGIN.test(actor.login)) {
    return `@${actor.login} is a ${actor.type} account, not a person`;
  }
  if (
    accounts.some(
      (account) => account !== undefined && same(account, actor.login),
    )
  ) {
    return `@${actor.login} is a configured pipeline account`;
  }
  return null;
}

function namesOrganization(
  membership: Membership,
  organization: string,
): boolean {
  const { organization: named } =
    ORGANIZATION_URL.exec(membership.organizationUrl)?.groups ?? {};
  return (
    named !== undefined &&
    same(named, organization) &&
    (membership.organization === undefined ||
      membership.organization === null ||
      same(membership.organization.login, organization))
  );
}

// Why the landing account can't read memberships of `organization`, or null
// when it is an active member there.
function readerProblem(cfg: Config, organization: string): string | null {
  const path = `user/memberships/orgs/${organization}`;
  const read = observeOne(cfg, path, MEMBERSHIP);
  if (read.status === "absent") {
    return `reader @${cfg.landingAccount} cannot see organization ${organization} (HTTP 404)`;
  }
  if (read.status === "unknown") {
    return `reader membership unreadable: ${read.reason}`;
  }
  const membership = read.value;
  if (!namesOrganization(membership, organization)) {
    return `reader membership names another organization than ${organization}`;
  }
  if (
    membership.user === null ||
    !same(membership.user.login, cfg.landingAccount)
  ) {
    return `reader membership is not @${cfg.landingAccount}'s`;
  }
  if (
    membership.state !== "active" ||
    !MEMBER_ROLES.includes(membership.role)
  ) {
    return `reader @${cfg.landingAccount} is not an active member of ${organization}`;
  }
  return null;
}

// Whether `login`, which must still be user `userId`, is an active member.
function membershipOf(
  cfg: Config,
  organization: string,
  producer: { login: string; userId: number },
): Qualification {
  const { login, userId } = producer;
  const problem = readerProblem(cfg, organization);
  if (problem !== null) {
    return unknown(problem);
  }
  const read = observeOne(
    cfg,
    `orgs/${organization}/memberships/${login}`,
    MEMBERSHIP,
  );
  if (read.status === "absent") {
    return rejected(`@${login} is not a member of ${organization}`);
  }
  if (read.status === "unknown") {
    return unknown(`membership of @${login} unreadable: ${read.reason}`);
  }
  const membership = read.value;
  if (!namesOrganization(membership, organization)) {
    return unknown(`membership of @${login} names another organization`);
  }
  if (membership.user === null || membership.user.id !== userId) {
    return unknown(
      `membership of @${login} belongs to another account than user ${userId}`,
    );
  }
  if (!same(membership.user.login, login)) {
    return unknown(`membership of @${login} names another login`);
  }
  if (membership.state === "pending") {
    return rejected(`@${login}'s invitation to ${organization} is pending`);
  }
  if (!MEMBER_ROLES.includes(membership.role)) {
    return rejected(
      `@${login} is a ${membership.role} of ${organization}, not a member`,
    );
  }
  return {
    status: "qualified",
    provenance: {
      route: "human",
      login: membership.user.login,
      userId,
      organization,
    },
  };
}

// Qualifies the actor of a label event for its first acceptance.
function qualifyActor(
  cfg: Config,
  organization: string,
  actor: EventActor,
): Qualification {
  const machine = machineReason(cfg, actor);
  if (machine !== null) {
    return rejected(machine);
  }
  return membershipOf(cfg, organization, {
    login: actor.login,
    userId: actor.id,
  });
}

// Qualifies an accepted signal's retained producer again: the same user id,
// under its current login, still an active member of the organization the
// signal was accepted under.
function requalifyProducer(
  cfg: Config,
  organization: string,
  provenance: HumanProvenance,
): Qualification {
  if (!same(provenance.organization, organization)) {
    return rejected(
      `accepted under organization ${provenance.organization}, not ${organization}`,
    );
  }
  const user = observeOne(cfg, `user/${provenance.userId}`, USER);
  if (user.status === "absent") {
    return rejected(`user ${provenance.userId} no longer exists`);
  }
  if (user.status === "unknown") {
    return unknown(`user ${provenance.userId} unreadable: ${user.reason}`);
  }
  if (user.value.id !== provenance.userId) {
    return unknown(`user ${provenance.userId} read back as another account`);
  }
  const current: EventActor = {
    login: user.value.login,
    id: user.value.id,
    type: user.value.type,
    viaApp: false,
  };
  const machine = machineReason(cfg, current);
  if (machine !== null) {
    return rejected(machine);
  }
  return membershipOf(cfg, organization, {
    login: user.value.login,
    userId: provenance.userId,
  });
}

export type { EventActor, Qualification };
export { GITHUB_LOGIN, machineReason, qualifyActor, requalifyProducer };
