// The layout of a stage job's folder (separate-checkouts, #338): its code
// checkout and its wiki checkout side by side, each in its own folder.
// Pure, so the sweep's prompts, which the sandbox runs, can name them too.

// The code checkout's folder in a stage job's folder.
const JOB_REPO = "repo";
// The wiki checkout's folder in a stage job's folder.
const JOB_DOCS = "docs";

export { JOB_DOCS, JOB_REPO };
