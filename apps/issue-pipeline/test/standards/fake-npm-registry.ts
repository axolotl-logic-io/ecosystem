// A fake npm registry for the standards sandbox tests, run as its own
// process: `node fake-npm-registry.ts DIR`. It serves DIR/tarballs/NAME.tgz
// at /NAME/-/NAME.tgz and answers npm audit's bulk advisory request from
// DIR/advisories.json ({} when missing). Every request is appended to
// DIR/hits.jsonl, and the port it listens on is written to DIR/port once
// it's ready.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";

const [dir = ""] = process.argv.slice(2);
const TARBALL = /^\/(?<name>[^/]+)\/-\/(?<file>[^/]+\.tgz)$/u;
const BULK = "/-/npm/v1/security/advisories/bulk";
const NOT_FOUND = 404;

function readOr(file: string, fallback = ""): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return fallback;
  }
}

const server = http.createServer((request, response) => {
  const url = request.url ?? "";
  fs.appendFileSync(
    path.join(dir, "hits.jsonl"),
    `${JSON.stringify({ method: request.method, url })}\n`,
  );
  request.resume();
  request.on("end", () => {
    const tarball = TARBALL.exec(url);
    if (request.method === "GET" && tarball !== null) {
      const { file = "" } = tarball.groups ?? {};
      const target = path.join(dir, "tarballs", file);
      if (fs.existsSync(target)) {
        response.setHeader("content-type", "application/octet-stream");
        response.end(fs.readFileSync(target));
        return;
      }
    }
    if (request.method === "POST" && url === BULK) {
      response.setHeader("content-type", "application/json");
      response.end(readOr(path.join(dir, "advisories.json"), "{}"));
      return;
    }
    response.statusCode = NOT_FOUND;
    response.end("{}");
  });
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address !== null && typeof address === "object") {
    fs.writeFileSync(path.join(dir, "port"), String(address.port));
  }
});
