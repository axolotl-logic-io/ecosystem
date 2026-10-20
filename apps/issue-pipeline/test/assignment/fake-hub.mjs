// @ts-check
import { z } from "zod";
import { OpsError } from "../../src/ops-error.ts";
import { request } from "./fake-wire.mjs";
import { SHA_LENGTH, TREE } from "./world.mjs";

/** @import { Hub } from '../../src/assignment/github.ts' */
/** @import { World } from './world.mjs' */
const PAGE_SIZE = 100;
const SHA_RADIX = 16;
const REF_BODY = z.object({ ref: z.string(), sha: z.string() });
const REQUEST = /^pulls\/(?<pr>\d+)\/requested_reviewers$/u;
/** @param {unknown[]} rows @param {URL} url */
function page(rows, url) {
  const size = Number(url.searchParams.get("per_page") ?? PAGE_SIZE);
  const at = (Number(url.searchParams.get("page") ?? 1) - 1) * size;
  return rows.slice(at, at + size);
}
/** @param {World} f @param {URL} url */
function readIssue(f, url) {
  const [, , id, child] = url.pathname.split("/");
  const number = Number(id);
  if (child === "events") {
    return page(f.events.get(number) ?? [], url);
  }
  if (id !== undefined) {
    return f.issues.get(number) ?? null;
  }
  let rows = [...f.issues.values()];
  const assignee = url.searchParams.get("assignee");
  if (assignee !== null) {
    rows = rows.filter((row) =>
      row.assignees.some((user) => user.login === assignee),
    );
  }
  if (url.searchParams.get("state") === "open") {
    rows = rows.filter((row) => row.state === "open");
  }
  return page(rows, url);
}
/** @param {World} f @param {URL} url */
function readPull(f, url) {
  const [, , id, child] = url.pathname.split("/");
  if (id === undefined) {
    return page(
      [...f.prs.values()].filter((pr) => pr.state === "open"),
      url,
    );
  }
  if (child === "reviews") {
    return page(f.reviews.get(Number(id)) ?? [], url);
  }
  return f.prs.get(Number(id)) ?? null;
}
/** @param {World} f @param {URL} url */
function readGit(f, url) {
  const prefix = "/git/ref/";
  if (url.pathname.startsWith(prefix)) {
    const sha = f.refs.get(url.pathname.slice(prefix.length));
    if (sha === undefined) {
      return null;
    }
    return { object: { sha } };
  }
  if (url.pathname.startsWith("/git/commits/")) {
    return f.commits.get(url.pathname.slice("/git/commits/".length));
  }
  if (url.pathname.startsWith("/git/matching-refs/")) {
    const refPrefix = url.pathname.slice("/git/matching-refs/".length);
    return page(
      [...f.refs.keys()]
        .filter((ref) => ref.startsWith(refPrefix))
        .map((ref) => ({ ref: `refs/${ref}` })),
      url,
    );
  }
  throw new Error(`unhandled fake read ${url.pathname}`);
}
/** @param {World} f @param {string} endpoint @param {object} body @param {"dev" | "merge"} identity @returns {unknown} */
function create(f, endpoint, body, identity) {
  f.writes.push(endpoint);
  if (endpoint === "git/commits") {
    f.world.sequence += 1;
    const sha = f.world.sequence.toString(SHA_RADIX).padStart(SHA_LENGTH, "0");
    const commit = { sha, tree: { sha: TREE }, message: JSON.stringify(body) };
    f.commits.set(sha, commit);
    return commit;
  }
  if (endpoint === "git/refs") {
    const parsed = REF_BODY.parse(body);
    const ref = parsed.ref.slice("refs/".length);
    if (f.refs.has(ref)) {
      throw new OpsError("HTTP 422 ref already exists");
    }
    f.refs.set(ref, parsed.sha);
    return {};
  }
  const { pr } = REQUEST.exec(endpoint)?.groups ?? {};
  if (pr !== undefined) {
    if (!f.prs.has(Number(pr)) || identity !== "dev") {
      throw new Error("wrong request identity or PR");
    }
    const row = f.prs.get(Number(pr));
    if (row !== undefined) {
      row.requested_reviewers = [{ login: f.cfg.mergeAccount }];
    }
    request(f, Number(pr), f.cfg.devAccount);
    if (f.world.failRequest) {
      throw new OpsError("response lost after review request");
    }
    return {};
  }
  throw new Error(`unhandled fake mutation ${endpoint}`);
}
/** @param {World} f @returns {Hub} */
function fakeHub(f) {
  return {
    allowed: (login) => f.allowed.has(login),
    read: (endpoint) => {
      f.reads.push(endpoint);
      const url = new URL(`https://fake/${endpoint}`);
      if (endpoint.startsWith("issues")) {
        return readIssue(f, url);
      }
      if (endpoint.startsWith("pulls")) {
        return readPull(f, url);
      }
      return readGit(f, url);
    },
    create: (endpoint, body, identity = "merge") =>
      create(f, endpoint, body, identity),
    remove: (endpoint) => {
      f.writes.push(endpoint);
      f.refs.delete(endpoint.slice("git/refs/".length));
    },
  };
}

export { fakeHub };
