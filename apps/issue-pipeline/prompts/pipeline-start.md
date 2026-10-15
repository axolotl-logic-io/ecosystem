---
description: Start an issue-pipeline lane in this session (session-only schedule)
argument-hint: "[repo config, default axolotl-logic__project-buddy]"
---
Start one issue-pipeline lane in this pi session. Do only the steps below, then stop.

1. Config: `{{ISSUE_PIPELINE_ROOT}}/repos/${1:-axolotl-logic__project-buddy}.json`. Check that the file exists with `ls`. If it doesn't, say so and stop.
2. `<lane>` is the first 8 characters of `$PI_SESSION_ID` (`echo $PI_SESSION_ID`), and `<slug>` is the config's file name without `.json`. Run `subagent({ action: "schedule.list" })`; it lists every schedule in this project, including other sessions' lanes. If one is named `issue-pipeline-<slug>-<lane>`, it is this session's: don't create another. If it is paused, resume it with `subagent({ action: "schedule.resume", id })`. Report it and stop.
3. Work out the path of `{{ISSUE_PIPELINE_ROOT}}/workflow.js` relative to this session's cwd (`pwd`), because `workflow` takes a path read from the request cwd.
4. Create the schedule:

   ```
   subagent({ action: "schedule.create", workflow: "<relative path to workflow.js>",
     args: { config: "<absolute config path>", lane: "<lane>" },
     options: { name: "issue-pipeline-<slug>-<lane>", every: "2m", overlap: "skip",
                catchUp: "none", quiet: true, sessionOnly: true } })
   ```

   `sessionOnly: true` is required: it keeps every fire in this session, so no other pi session starts the pipeline. `lane` is required: it lets this lane keep its issue from sweep to sweep and race other lanes for new ones. Don't pass `mission`.
5. Report the schedule id and name in one line. This session is now one lane, and each sweep works on one issue. Closing this session stops the lane, and reopening it re-arms the schedule unless it was paused first (`/pipeline-pause`).
