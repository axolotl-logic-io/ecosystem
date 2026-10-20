// Each call is one authenticated GitHub request attempt, without hidden
// pagination or retries. There is no mutation or credential-selection API.
import type { z } from "zod";
import { DiscoveryHold } from "./hold.ts";
import { hasNext, PAGE_SIZE } from "./pagination.ts";
import { type COMMENT_QUERY, RESPONSE } from "./schema.ts";

type ReadRequest =
  | { kind: "rest"; repository: string; method: "GET"; path: string }
  | {
      kind: "comment";
      repository: string;
      query: typeof COMMENT_QUERY;
      id: string;
    };
interface DiscoveryReader {
  read: (request: ReadRequest) => Promise<unknown>;
}
const HTTP_OK = 200;
const HTTP_NO_CONTENT = 204;
const HTTP_NOT_FOUND = 404;

class Reads {
  count = 0;
  private readonly reader: DiscoveryReader;
  private readonly budget: number;

  constructor(reader: DiscoveryReader, budget: number) {
    this.reader = reader;
    this.budget = budget;
  }

  async request(request: ReadRequest): Promise<z.infer<typeof RESPONSE>> {
    const evidence = JSON.stringify(request);
    if (this.count >= this.budget) {
      throw new DiscoveryHold({ reason: "budget", evidence, incomplete: true });
    }
    this.count += 1;
    try {
      return RESPONSE.parse(await this.reader.read(request));
    } catch (cause) {
      throw new DiscoveryHold(
        { reason: "read", evidence, incomplete: true },
        { cause },
      );
    }
  }

  async get(repository: string, path: string): Promise<unknown> {
    const reply = await this.request({
      kind: "rest",
      repository,
      method: "GET",
      path,
    });
    if (reply.status !== HTTP_OK) {
      throw new DiscoveryHold({
        reason: "read",
        evidence: path,
        incomplete: true,
      });
    }
    return reply.body;
  }

  private pageStream<T>(
    repository: string,
    path: string,
    schema: z.ZodType<T>,
  ): AsyncIterable<T[]> {
    let page = 1;
    let done = false;
    let separator = "?";
    if (path.includes("?")) {
      separator = "&";
    }
    const iterator: AsyncIterableIterator<T[]> = {
      [Symbol.asyncIterator]: (): AsyncIterableIterator<T[]> => iterator,
      next: async (): Promise<IteratorResult<T[]>> => {
        if (done) {
          return { done: true, value: [] };
        }
        const current = `${path}${separator}per_page=${PAGE_SIZE}&page=${page}`;
        const reply = await this.request({
          kind: "rest",
          repository,
          method: "GET",
          path: current,
        });
        const rows = schema.array().safeParse(reply.body);
        if (
          reply.status !== HTTP_OK ||
          !rows.success ||
          rows.data.length > PAGE_SIZE
        ) {
          throw new DiscoveryHold({
            reason: "page",
            evidence: current,
            incomplete: true,
          });
        }
        done = !hasNext(reply.link, current, rows.data.length);
        page += 1;
        return { done: false, value: rows.data };
      },
    };
    return iterator;
  }

  async pages<T>(
    repository: string,
    path: string,
    schema: z.ZodType<T>,
  ): Promise<T[]> {
    const result: T[] = [];
    for await (const rows of this.pageStream(repository, path, schema)) {
      result.push(...rows);
    }
    return result;
  }

  async collaborator(repository: string, login: string): Promise<boolean> {
    const path = `/repos/${repository}/collaborators/${login}`;
    const reply = await this.request({
      kind: "rest",
      repository,
      method: "GET",
      path,
    });
    if (reply.status === HTTP_NO_CONTENT) {
      return true;
    }
    if (reply.status === HTTP_NOT_FOUND) {
      return false;
    }
    throw new DiscoveryHold({
      reason: "read",
      evidence: path,
      incomplete: true,
    });
  }
}

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export type { DiscoveryReader, ReadRequest };
export { Reads, same };
