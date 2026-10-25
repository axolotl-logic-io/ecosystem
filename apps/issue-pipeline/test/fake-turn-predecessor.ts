// A delayed predecessor's late turn release (#171): with the exact binding
// of an earlier Land invocation, read from its turn request, it releases
// the target's integration turn through the real transport, as that
// invocation would have once it finished. It reads the frame on stdin (the
// config, issue, checkout and binding) and prints why it was refused.
import fs from "node:fs";
import process from "node:process";

const src: string = new URL("../src/", import.meta.url).pathname;
const { loadConfig, withCheckout }: typeof import("../src/config.ts") =
  await import(`${src}config.ts`);
const { integrationTurn, withExecution }: typeof import("../src/execution.ts") =
  await import(`${src}execution.ts`);

const frame = JSON.parse(fs.readFileSync(0, "utf8"));
const cfg = withCheckout(loadConfig(frame.config), frame.checkout);
try {
  integrationTurn(withExecution(cfg, frame.execution), frame.number).release();
  process.stdout.write(JSON.stringify({ released: true }));
} catch (error) {
  process.stdout.write(JSON.stringify({ refused: String(error) }));
}
