// A buddy whose models are Anthropic's, served through the operator's
// pi-cliproxyapi profile: Implement launches pi with the anthropic model,
// the runtime accepts the base URL pi registers without the endpoint's /v1,
// and the task settles as it does through OpenAI. Only gh and pi are fakes.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PlannedSession } from "./buddy-flow-test-kit.ts";
import { HARDENING, machine } from "./buddy-flow-test-kit.ts";

const COUNTS: PlannedSession = {
  commit: {
    file: "counter.txt",
    content: "3 widgets\n",
    message: "Count the widgets",
  },
  change: null,
  changeFirst: false,
  awaitAbort: false,
  reply: { outcome: "done", summary: "Counted the widgets." },
};

test("a buddy implements a started issue with Anthropic models behind CLIProxy", async () => {
  const box = machine(undefined, {
    landPermission: false,
    provider: "anthropic",
  });
  try {
    const { status, actions } = await box.runBuddy([COUNTS, HARDENING], 2);
    assert.equal(status, 0);
    assert.deepEqual(
      actions.map((action) => [action.outcome, action.verdict]),
      [["succeeded", "passed"]],
    );
    const models = box
      .launches()
      .map(({ args }) => args[args.indexOf("--model") + 1]);
    assert.deepEqual(models, ["anthropic/fake-model", "anthropic/fake-model"]);
  } finally {
    box.cleanup();
  }
});
