// Marker syntax describes pipeline content, never authenticated identity.

const STATE_MARK = "<!-- agent-pipeline:state";
const STATE_HEADER = "**🤖 issue-pipeline · state**";
const PIPELINE_MARK = /<!-- agent-pipeline:comment role=(?<role>[\w.:-]+) -->/u;
function isCoordinationBody(body: string): boolean {
  return body.includes("agent-pipeline:coordination");
}

// State must occupy the comment itself, not a quoted diagnostic or body field.
function isStateBody(body: string): boolean {
  return (
    body.startsWith(STATE_MARK) ||
    body.startsWith(`${STATE_HEADER}\n${STATE_MARK}`)
  );
}

export {
  isCoordinationBody,
  isStateBody,
  PIPELINE_MARK,
  STATE_HEADER,
  STATE_MARK,
};
