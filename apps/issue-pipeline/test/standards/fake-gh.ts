// Only the read calls made by standards-upgrade apply, over a real gh
// subprocess boundary. Any other command fails instead of reaching GitHub.
import fs from "node:fs";
import process from "node:process";
import { z } from "zod";

const WORLD = z.strictObject({
  issue: z.number().int().positive(),
  body: z.string(),
  collaboratorReadable: z.boolean(),
});
const {
  STANDARDS_WORLD: file = "",
  STANDARDS_CALLS: calls = "",
}: NodeJS.ProcessEnv = process.env;
const world = WORLD.parse(JSON.parse(fs.readFileSync(file, "utf8")));
const args = process.argv.slice(2);
fs.appendFileSync(calls, `${JSON.stringify(args)}\n`);
const [command, endpoint]: string[] = args;

if (command === "api" && endpoint === "user") {
  console.log("land-bot");
} else if (
  command === "api" &&
  endpoint === `repos/o/r/issues/${world.issue}`
) {
  console.log(
    JSON.stringify({
      body: world.body,
      state: "open",
      login: "alice",
      pull: false,
    }),
  );
} else if (command === "api" && endpoint === "repos/o/r/collaborators/alice") {
  if (!world.collaboratorReadable) {
    console.error("HTTP 404: collaborator evidence unreadable");
    process.exitCode = 1;
  }
} else if (command === "issue" && endpoint === "list") {
  console.log(JSON.stringify([{ number: world.issue, body: world.body }]));
} else {
  console.error(`unexpected fixture gh call: ${JSON.stringify(args)}`);
  process.exitCode = 1;
}
