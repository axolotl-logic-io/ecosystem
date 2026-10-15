---
description: Pause this session's issue-pipeline lane
---
Pause the issue-pipeline lane that belongs to this pi session. Do only the steps below.

1. `<lane>` is the first 8 characters of `$PI_SESSION_ID` (`echo $PI_SESSION_ID`). Run `subagent({ action: "schedule.list" })`; it lists every schedule in this project, including other sessions' lanes. Pick only the ones named `issue-pipeline-<anything>-<lane>`.
2. Pause each with `subagent({ action: "schedule.pause", id })`. A sweep that is already running finishes; pausing only stops new fires.
3. Report the ids you paused in one line. `/pipeline-start` resumes a paused lane instead of creating a new one.
