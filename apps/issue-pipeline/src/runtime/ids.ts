// The runtime's identities. A buddy run is one activation of a buddy; an
// action run is one admitted action, whose id is also its invocation's
// `instance` and its task attempt's `run.id`; a model session is one launch
// an action started, with an identity of its own that names its action as
// its parent. Each is a fresh UUID that is never reused or relabeled, and
// each has its own type, so one never stands in for another.

import { z } from "zod";

const BUDDY_RUN_ID = z.uuid().brand<"BuddyRunId">();
const ACTION_RUN_ID = z.uuid().brand<"ActionRunId">();
const SESSION_ID = z.uuid().brand<"SessionId">();

type BuddyRunId = z.infer<typeof BUDDY_RUN_ID>;
type ActionRunId = z.infer<typeof ACTION_RUN_ID>;
type SessionId = z.infer<typeof SESSION_ID>;

function newBuddyRunId(): BuddyRunId {
  return BUDDY_RUN_ID.parse(crypto.randomUUID());
}

function newActionRunId(): ActionRunId {
  return ACTION_RUN_ID.parse(crypto.randomUUID());
}

function newSessionId(): SessionId {
  return SESSION_ID.parse(crypto.randomUUID());
}

export type { ActionRunId, BuddyRunId, SessionId };
export {
  ACTION_RUN_ID,
  BUDDY_RUN_ID,
  newActionRunId,
  newBuddyRunId,
  newSessionId,
  SESSION_ID,
};
