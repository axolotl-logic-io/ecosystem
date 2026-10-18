// Cuts text for a comment, a log line or saved state.

const ELLIPSIS = "…";

// The value as text, cut to `limit` characters with an ellipsis after the cut.
// null and undefined read as "".
function clip(value: unknown, limit: number): string {
  const text = String(value ?? "");
  if (text.length > limit) {
    return `${text.slice(0, limit)}${ELLIPSIS}`;
  }
  return text;
}

export { clip };
