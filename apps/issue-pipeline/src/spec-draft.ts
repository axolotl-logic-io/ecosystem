// Where the spec writer keeps its spec draft on the issue's branch, relative
// to the repo root. It is committed as the session goes, found on a restart,
// never counted as a changed file, and removed once the spec is posted, so
// the implementor doesn't take it for work either.
const SPEC_DRAFT = ".issue-pipeline/spec-draft.md";

export { SPEC_DRAFT };
