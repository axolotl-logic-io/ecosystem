// Strict GitHub GET observations. Each call is one authenticated `gh api
// --include` request per page, read by a repository config's landing
// account or by a given token's environment, with its HTTP status kept and no hidden retries. Listings walk
// explicit pages and check each page's Link header, so a listing is complete
// only when every page was read. A failed, partial or malformed read is an
// unknown observation, never an empty one.
import { z } from "zod";
import { GH_TIMEOUT_MS } from "./github-read.ts";
import { credentialedRun } from "./transport.ts";

type Observation<T> =
  | { status: "ok"; value: T }
  // HTTP 404: callers decide what absence means for each endpoint.
  | { status: "absent" }
  | { status: "unknown"; reason: string };

// Who reads: a repository config, through its landing account, or the
// verified `gh` environment of one account.
type Reader = ReadonlyMap<string, string> | (() => ReadonlyMap<string, string>);

interface Response {
  status: number;
  link: string | null;
  body: unknown;
}

const PAGE_SIZE = 100;
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const STATUS_LINE = /^HTTP\/[\d.]+ (?<code>\d{3})\b/u;
const HEADER_END = /\r?\n\r?\n/u;
const LINE_BREAK = /\r?\n/u;
const LINK_HEADER = /^link:\s*(?<value>.*)$/iu;
const LINK = /^<(?<url>[^>]+)>;\s*rel="(?<relation>next|prev|first|last)"$/u;
// GitHub's page links may name a repository by its numeric id rather than
// by owner and name.
const REPOS_PATH = /^\/repos\/[^/]+\/[^/]+(?<rest>\/.*)?$/u;
const REPOSITORIES_PATH = /^\/repositories\/\d+(?<rest>\/.*)?$/u;
const API_ORIGIN = "https://api.github.com";
const STDERR_LIMIT = 300;
const ROW_ID = z.looseObject({ id: z.number().int().positive() });

function failure(reason: string): { status: "unknown"; reason: string } {
  return { status: "unknown", reason };
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

// gh prints `--include` output as a status line, headers, a blank line and
// the body, on stdout, whatever the status.
function parseResponse(stdout: string): Response | null {
  const { code } = STATUS_LINE.exec(stdout)?.groups ?? {};
  if (code === undefined) {
    return null;
  }
  const split = HEADER_END.exec(stdout);
  let head = stdout;
  let text = "";
  if (split !== null) {
    head = stdout.slice(0, split.index);
    text = stdout.slice(split.index + split[0].length);
  }
  let link: string | null = null;
  for (const line of head.split(LINE_BREAK)) {
    const { value } = LINK_HEADER.exec(line)?.groups ?? {};
    if (value !== undefined) {
      link = value.trim();
    }
  }
  let body: unknown = null;
  if (text.trim() !== "") {
    try {
      body = JSON.parse(text);
    } catch {
      return null;
    }
  }
  return { status: Number(code), link, body };
}

function readerEnv(reader: Reader): ReadonlyMap<string, string> {
  if (typeof reader === "function") {
    return reader();
  }
  return reader;
}

function request(reader: Reader, path: string): Observation<Response> {
  let env: ReadonlyMap<string, string>;
  try {
    env = readerEnv(reader);
  } catch (error) {
    return failure(`reader credential unusable: ${errorText(error)}`);
  }
  const result = credentialedRun(
    "gh",
    ["api", "--include", "--method", "GET", path],
    { env, allowFail: true, timeoutMs: GH_TIMEOUT_MS },
  );
  if (result.timedOut) {
    return failure(`GET ${path} timed out`);
  }
  const response = parseResponse(result.stdout);
  if (response === null) {
    const stderr = result.stderr.trim().slice(0, STDERR_LIMIT);
    return failure(
      `GET ${path} gave no readable response (gh exit ${result.code}): ${stderr}`,
    );
  }
  return { status: "ok", value: response };
}

// One GET of `path`: 200 parsed by `schema`, 404 absent, anything else unknown.
function observeOne<S extends z.ZodType>(
  reader: Reader,
  path: string,
  schema: S,
): Observation<z.output<S>> {
  const sent = request(reader, path);
  if (sent.status !== "ok") {
    return sent;
  }
  const { status, body } = sent.value;
  if (status === HTTP_NOT_FOUND) {
    return { status: "absent" };
  }
  if (status !== HTTP_OK) {
    return failure(`GET ${path} answered HTTP ${status}`);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return failure(`GET ${path} answered an unexpected shape`);
  }
  return { status: "ok", value: parsed.data };
}

// Why an observation that isn't ok can't be used.
function unreadable(
  observation: Exclude<Observation<unknown>, { status: "ok" }>,
): string {
  if (observation.status === "absent") {
    return "GitHub answered HTTP 404";
  }
  return observation.reason;
}

function pageOf(url: URL): number {
  return Number(url.searchParams.get("page"));
}

function samePath(link: string, current: string): boolean {
  if (link === current) {
    return true;
  }
  const repos = REPOS_PATH.exec(current);
  const repositories = REPOSITORIES_PATH.exec(link);
  if (repos === null || repositories === null) {
    return false;
  }
  const { rest: wanted = "" } = repos.groups ?? {};
  const { rest: given = "" } = repositories.groups ?? {};
  return wanted === given;
}

// The page a Link URL names, once it proves the same endpoint and filters as
// `current`; null when it leaves them.
function linkedPage(raw: string, current: URL): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const page = pageOf(url);
  if (
    url.origin !== current.origin ||
    url.hash !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    !samePath(url.pathname, current.pathname) ||
    !Number.isSafeInteger(page) ||
    page < 1
  ) {
    return null;
  }
  const expected = new URLSearchParams(current.searchParams);
  expected.set("page", String(page));
  expected.sort();
  const given = new URLSearchParams(url.searchParams);
  given.sort();
  if (given.toString() !== expected.toString()) {
    return null;
  }
  return url;
}

function contradicts(
  relations: ReadonlyMap<string, URL>,
  page: number,
): boolean {
  const next = relations.get("next");
  const last = relations.get("last");
  const first = relations.get("first");
  const prev = relations.get("prev");
  if (first !== undefined && pageOf(first) !== 1) {
    return true;
  }
  if (prev !== undefined && pageOf(prev) !== page - 1) {
    return true;
  }
  if (next !== undefined && pageOf(next) !== page + 1) {
    return true;
  }
  if (last === undefined) {
    return false;
  }
  if (next === undefined) {
    return pageOf(last) !== page;
  }
  return pageOf(last) <= page;
}

// Whether the listing continues past `page`, or null when the Link header
// is malformed or contradicts the page that was read.
function continues(
  link: string | null,
  current: URL,
  count: number,
): boolean | null {
  const page = pageOf(current);
  if (link === null || link === "") {
    // No header proves no later page, so a full page reads one more.
    return count === PAGE_SIZE;
  }
  const relations = new Map<string, URL>();
  for (const part of link.split(",")) {
    const { url, relation } = LINK.exec(part.trim())?.groups ?? {};
    if (
      url === undefined ||
      relation === undefined ||
      relations.has(relation)
    ) {
      return null;
    }
    const linked = linkedPage(url, current);
    if (linked === null) {
      return null;
    }
    relations.set(relation, linked);
  }
  if (contradicts(relations, page)) {
    return null;
  }
  if (!relations.has("next")) {
    return !relations.has("last") && count === PAGE_SIZE;
  }
  if (count === 0) {
    return null;
  }
  return true;
}

// Every row of the listing at `path`, page by page. Any failed page, a
// contradictory Link header, an oversized page or a row id seen twice makes
// the whole listing unknown.
function observeAll<S extends z.ZodType>(
  reader: Reader,
  path: string,
  row: S,
): Observation<z.output<S>[]> {
  let separator = "?";
  if (path.includes("?")) {
    separator = "&";
  }
  const rows: z.output<S>[] = [];
  const ids = new Set<number>();
  for (let page = 1; ; page += 1) {
    const current = `${path}${separator}per_page=${PAGE_SIZE}&page=${page}`;
    const sent = request(reader, current);
    if (sent.status !== "ok") {
      return sent;
    }
    const { status, body, link } = sent.value;
    if (status !== HTTP_OK) {
      return failure(`GET ${current} answered HTTP ${status}`);
    }
    const parsed = z.array(row).safeParse(body);
    const keyed = z.array(ROW_ID).safeParse(body);
    if (!(parsed.success && keyed.success)) {
      return failure(`GET ${current} answered an unexpected shape`);
    }
    if (parsed.data.length > PAGE_SIZE) {
      return failure(`GET ${current} answered an oversized page`);
    }
    for (const { id } of keyed.data) {
      if (ids.has(id)) {
        return failure(`GET ${current} repeated row ${id} across pages`);
      }
      ids.add(id);
    }
    rows.push(...parsed.data);
    const more = continues(
      link,
      new URL(`${API_ORIGIN}/${current}`),
      parsed.data.length,
    );
    if (more === null) {
      return failure(`GET ${current} answered a contradictory Link header`);
    }
    if (more === false) {
      return { status: "ok", value: rows };
    }
  }
}

export type { Observation, Reader };
export { errorText, observeAll, observeOne, unreadable };
