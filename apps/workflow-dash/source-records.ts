/** The JSON value of `text`, or null when it is not JSON. */
function parse(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    return null;
  }
}

export { parse };
