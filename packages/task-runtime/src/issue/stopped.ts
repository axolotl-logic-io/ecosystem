// The stop label, and the error a run meets when it is on the issue.
const STOP_LABEL = "agents:stop";

// `agents:stop` is on the issue: the run ends where it is.
class Stopped extends Error {
  constructor() {
    super(`${STOP_LABEL} is on the issue`);
  }
}

export { STOP_LABEL, Stopped };
