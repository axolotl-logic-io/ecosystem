// @ts-check
// A fake package index for the standards sandbox tests, run as its own
// process: `node fake-pypi.mjs DIR`. It serves DIR/wheels/*.whl through a
// PEP 503 simple index (/simple/NAME/ links to /files/FILE). Every request
// is appended to DIR/hits.jsonl, and the port it listens on is written to
// DIR/port once it's ready.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";

const [dir = ""] = process.argv.slice(2);
const SIMPLE = /^\/simple\/(?<name>[^/]+)\/?$/u;
const FILE = /^\/files\/(?<file>[^/]+\.whl)$/u;
const SEPARATORS = /[-_.]+/gu;
const NOT_FOUND = 404;

/** @param {string} name */
function normalized(name) {
  return name.toLowerCase().replace(SEPARATORS, "-");
}

function wheels() {
  const folder = path.join(dir, "wheels");
  if (!fs.existsSync(folder)) {
    return [];
  }
  return fs.readdirSync(folder).filter((file) => file.endsWith(".whl"));
}

const server = http.createServer((request, response) => {
  const url = request.url ?? "";
  fs.appendFileSync(
    path.join(dir, "hits.jsonl"),
    `${JSON.stringify({ method: request.method, url })}\n`,
  );
  const simple = SIMPLE.exec(url);
  if (simple !== null) {
    const { name = "" } = simple.groups ?? {};
    const links = wheels()
      .filter((whl) => normalized(whl.split("-")[0] ?? "") === normalized(name))
      .map((whl) => `<a href="/files/${whl}">${whl}</a>`);
    response.setHeader("content-type", "text/html");
    response.end(
      `<!DOCTYPE html><html><body>${links.join("\n")}</body></html>\n`,
    );
    return;
  }
  const file = FILE.exec(url);
  if (file !== null) {
    const { file: name = "" } = file.groups ?? {};
    const target = path.join(dir, "wheels", name);
    if (fs.existsSync(target)) {
      response.setHeader("content-type", "application/octet-stream");
      response.end(fs.readFileSync(target));
      return;
    }
  }
  response.statusCode = NOT_FOUND;
  response.end("not found\n");
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address !== null && typeof address === "object") {
    fs.writeFileSync(path.join(dir, "port"), String(address.port));
  }
});
