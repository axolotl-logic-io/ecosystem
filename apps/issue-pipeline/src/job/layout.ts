// The stage job's paths: its code checkout and a docs alias of the wiki
// submodule. The alias keeps the stages' prompts and commit scopes stable.
// Pure, so the sweep's prompts, which the sandbox runs, can name them too.

// The code checkout's folder in a stage job's folder.
const JOB_REPO = "repo";
// The wiki submodule's alias in a stage job's folder.
const JOB_DOCS = "docs";

export { JOB_DOCS, JOB_REPO };
