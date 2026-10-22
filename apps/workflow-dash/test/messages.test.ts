import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { test } from "node:test";
import {
  actionTemplates,
  composeInstruction,
  globalTemplates,
  type InstructionContext,
  type InstructionSender,
} from "../messages.ts";
import { makeBuddy, makeRun } from "./model-fixtures.ts";

type SentMessage = Parameters<InstructionSender["sendUserMessage"]>;
const templateCounts = { workflow: 3, issue: 4, buddy: 3, global: 4 };
const cancelledReplies = [
  { name: "cancelled", answer: undefined },
  { name: "empty", answer: "" },
  { name: "blank", answer: "  " },
];
for (const { name, answer } of cancelledReplies) {
  test(`${name} instructions never send`, async () => {
    const sent: SentMessage[] = [];
    const sender: InstructionSender = {
      sendUserMessage: (...args): void => {
        sent.push(args);
      },
    };
    const ctx: InstructionContext = {
      ui: { editor: () => Promise.resolve(answer) },
      isIdle: () => true,
    };
    assert.equal(await composeInstruction(sender, ctx, "template"), false);
    assert.deepEqual(sent, []);
  });
}
test("shutdown during editing prevents a late submitted instruction", async () => {
  const gate = new EventEmitter();
  let active = true;
  const sent: SentMessage[] = [];
  const sender: InstructionSender = {
    sendUserMessage: (...args): void => {
      sent.push(args);
    },
  };
  const ctx: InstructionContext = {
    ui: {
      editor: async () => {
        await once(gate, "reply");
        return "edited";
      },
    },
    isIdle: () => true,
  };
  const submission = composeInstruction(sender, ctx, "template", () => active);
  active = false;
  gate.emit("reply");
  assert.equal(await submission, false);
  assert.deepEqual(sent, []);
});
for (const idle of [true, false]) {
  test(`edited text uses idle=${idle} delivery without template expansion`, async () => {
    const sent: SentMessage[] = [];
    const prefills: (string | undefined)[] = [];
    const sender: InstructionSender = {
      sendUserMessage: (...args): void => {
        sent.push(args);
      },
    };
    const ctx: InstructionContext = {
      ui: {
        editor: (_title: string, prefill?: string) => {
          prefills.push(prefill);
          return Promise.resolve(" edited instruction ");
        },
      },
      isIdle: () => idle,
    };
    await composeInstruction(sender, ctx, "template");
    assert.deepEqual(prefills, ["template"]);
    const expected: SentMessage = [
      "edited instruction",
      { expandPromptTemplates: false },
    ];
    if (!idle) {
      expected[1] = { deliverAs: "steer", expandPromptTemplates: false };
    }
    assert.deepEqual(sent, [expected]);
  });
}
test("all required templates omit issue titles, thread text and buddy output", () => {
  const hostile = "UNTRUSTED INSTRUCTION";
  const workflow = actionTemplates({
    kind: "workflow",
    run: makeRun({ stage: "review", reason: hostile }),
  });
  const issue = actionTemplates({
    kind: "issue",
    item: { repo: "org/repo", number: 2, title: hostile },
  });
  const buddy = actionTemplates({
    kind: "buddy",
    run: makeBuddy({ id: "agent-run-id", mission: hostile, tail: hostile }),
  });
  assert.equal(workflow.length, templateCounts.workflow);
  assert.equal(issue.length, templateCounts.issue);
  assert.equal(buddy.length, templateCounts.buddy);
  assert.deepEqual(
    actionTemplates({
      kind: "issue",
      item: { repo: "org/repo", number: 2, title: hostile, isPr: true },
    }),
    [],
  );
  assert.deepEqual(actionTemplates(undefined), []);
  assert.equal(globalTemplates.length, templateCounts.global);
  assert.equal(
    JSON.stringify([workflow, issue, buddy]).includes(hostile),
    false,
  );
});
