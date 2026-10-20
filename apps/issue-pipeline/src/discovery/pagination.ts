import { DiscoveryHold } from "./hold.ts";

const LINK = /^<(?<url>[^>]+)>;\s*rel="(?<relation>next|prev|first|last)"$/u;
const PAGE_SIZE = 100;

function pageUrl(raw: string, current: URL): URL {
  const next = new URL(raw);
  if (
    next.origin !== current.origin ||
    next.pathname !== current.pathname ||
    next.hash !== "" ||
    next.username !== "" ||
    next.password !== ""
  ) {
    throw new Error("pagination leaves its endpoint");
  }
  const page = next.searchParams.get("page");
  if (
    page === null ||
    !Number.isSafeInteger(Number(page)) ||
    Number(page) < 1
  ) {
    throw new Error("invalid page");
  }
  const expected = new URL(current);
  expected.searchParams.set("page", page);
  expected.searchParams.sort();
  next.searchParams.sort();
  if (next.href !== expected.href) {
    throw new Error("pagination changes filters");
  }
  return next;
}

function hasNext(link: string | null, path: string, count: number): boolean {
  if (link === null) {
    return count === PAGE_SIZE;
  }
  const current = new URL(`https://api.github.com${path}`);
  const relations = new Map<string, URL>();
  try {
    for (const part of link.split(",")) {
      const { url, relation } = LINK.exec(part.trim())?.groups ?? {};
      if (
        url === undefined ||
        relation === undefined ||
        relations.has(relation)
      ) {
        throw new Error("malformed Link header");
      }
      relations.set(relation, pageUrl(url, current));
    }
    const next = relations.get("next");
    if (next === undefined) {
      return false;
    }
    if (
      count === 0 ||
      Number(next.searchParams.get("page")) !==
        Number(current.searchParams.get("page")) + 1
    ) {
      throw new Error("missing page");
    }
    return true;
  } catch (cause) {
    throw new DiscoveryHold(
      { reason: "page", evidence: path, incomplete: true },
      { cause },
    );
  }
}

export { hasNext, PAGE_SIZE };
