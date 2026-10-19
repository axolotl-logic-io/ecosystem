// What `shell` (shell-command.ts) and the shell supervisor (shell-supervisor.ts)
// say to each other: the request the supervisor takes as its one argument,
// and the report it prints as JSON on stdout once the command has ended and
// its process group is empty (commands-leave-no-processes, #371).

import { z } from "zod";

// How long a command's process group has to exit after its SIGTERM before
// it gets SIGKILL, and then to be empty. It must stay below the stage job's
// STOP_GRACE_MS (src/job/control.ts), so that a supervisor whose op the job
// stops finishes its kill before the job's SIGKILL reaches it.
const SHELL_KILL_GRACE_MS = 2000;
// The most of each of the command's outputs the supervisor keeps, so that
// the report fits `shell`'s buffer.
const SHELL_OUTPUT_CAP = 67_108_864; // 64 MiB

// One command line, run by `bash -lc`, and its time limit.
const SHELL_REQUEST = z.object({
  command: z.string(),
  timeoutMs: z.number().int().positive(),
});

const KILLED = z.object({
  pgid: z.number().int(),
  // Null when they couldn't be listed.
  pids: z.array(z.number().int()).nullable(),
  signals: z.union([
    z.tuple([z.literal("SIGTERM")]),
    z.tuple([z.literal("SIGTERM"), z.literal("SIGKILL")]),
  ]),
});

// How the command ended: what it printed, bash's exit status or signal,
// whether its time ran out, and what was left in its group and signalled,
// null when nothing was.
const SHELL_REPORT = z.object({
  stdout: z.string(),
  stderr: z.string(),
  status: z.number().int().nullable(),
  signal: z.string().nullable(),
  timedOut: z.boolean(),
  killed: KILLED.nullable(),
});

type ShellRequest = z.infer<typeof SHELL_REQUEST>;
type ShellReport = z.infer<typeof SHELL_REPORT>;
type ShellKilled = z.infer<typeof KILLED>;

export type { ShellKilled, ShellReport, ShellRequest };
export { SHELL_KILL_GRACE_MS, SHELL_OUTPUT_CAP, SHELL_REPORT, SHELL_REQUEST };
