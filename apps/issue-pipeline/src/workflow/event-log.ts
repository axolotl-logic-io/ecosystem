// The issue's event log in its saved state: the latest events, each a line
// stamped with the minute it happened (UTC).

import { clip } from "./clip.ts";
import type { IssueState } from "./types.ts";

// How many of the latest events the state keeps.
const KEPT_EVENTS = 30;
// The longest event text a line keeps.
const EVENT_LIMIT = 200;
// The length of an ISO time cut to the minute, "2026-10-15T12:00".
const MINUTE_STAMP = 16;

// Adds `text`, as it happened at `at`, to the end of the state's log, dropping
// the oldest lines past the last 30.
function noteEvent(st: Pick<IssueState, "log">, text: string, at: Date): void {
  const stamp = at.toISOString().slice(0, MINUTE_STAMP);
  st.log = [...(st.log ?? []), `${stamp}Z ${clip(text, EVENT_LIMIT)}`].slice(
    -KEPT_EVENTS,
  );
}

export { noteEvent };
