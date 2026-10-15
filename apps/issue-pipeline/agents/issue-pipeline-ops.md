---
name: issue-pipeline-ops
description: Deterministic git and GitHub operations for the issue pipeline workflow. Reads one JSON op from stdin, prints one JSON reply. No model.
runner:
  type: external-cli
  command: node
  args: ["{{ISSUE_PIPELINE_ROOT}}/ops.mjs"]
  promptDelivery: stdin
async: true
systemPromptMode: replace
inheritProjectContext: false
inheritGlobalContext: false
inheritSkills: false
---

Issue pipeline ops request follows.
