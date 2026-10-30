// The signal/runtime fake's state and GitHub answers. The shared service
// owns the gh wire protocol, serialization and lifetime of this process.
import process from "node:process";
import { gh } from "./fake-gh.ts";
import type { Reply } from "./fake-gh-call.ts";
import { type Request, serveFakeGitHub } from "./fake-gh-service.ts";
import {
  parseWorld,
  readWorld,
  type World,
  writeWorld,
} from "./fake-github-world.ts";

const [socket = "", worldFile = "", logFile = "", ready = ""] =
  process.argv.slice(2);
let world: World = readWorld(worldFile);
function commit(next: World): void {
  world = structuredClone(writeWorld(worldFile, next));
}

serveFakeGitHub({
  socket,
  ready,
  call: (request: Request): Reply =>
    gh(structuredClone(world), { ...request, log: logFile }, commit),
  read: (): string => JSON.stringify(world),
  write: (text: string): void => commit(parseWorld(text)),
});
