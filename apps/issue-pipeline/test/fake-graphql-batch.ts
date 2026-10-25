// The fakes' reading of a batched comment-provenance query
// (src/comment-authority.ts's currentComments): one GraphQL request with an
// alias `c<n>` per comment, its node id in variable `c<n>`. Embedded fake scripts take the same
// parser as source text.

// The node ids a `gh api graphql` call's batched query names, its `c<n>`
// variables in alias order, or null for a call that isn't a batch.
function batchIds(args: readonly string[]): string[] | null {
  const ids: string[] = [];
  for (let at = 0; args.some((arg) => arg.startsWith(`c${at}=`)); at += 1) {
    const field = args.find((arg) => arg.startsWith(`c${at}=`)) ?? "";
    ids.push(field.slice(field.indexOf("=") + 1));
  }
  if (ids.length === 0) {
    return null;
  }
  return ids;
}

// The batch's answer: each alias's node, as `nodeOf` reads it.
function batchAnswer(
  ids: readonly string[],
  nodeOf: (id: string) => unknown,
): string {
  const data = Object.fromEntries(ids.map((id, at) => [`c${at}`, nodeOf(id)]));
  return JSON.stringify({ data });
}

// batchIds and batchAnswer as source, for a fake that runs as its own script.
const BATCH_GRAPHQL = `${batchIds.toString()}\n${batchAnswer.toString()}\n`;

export { BATCH_GRAPHQL, batchAnswer, batchIds };
