// The pipeline's four stages, in the order an issue moves through them, and
// the statuses an issue's saved state can hold. Each stage is one stage job
// (`job.mjs --stage <stage>`); `stopped` and `done` are where an issue rests.

const STAGES = ["author", "implement", "review", "merge"] as const;

type Stage = (typeof STAGES)[number];

type Status = Stage | "stopped" | "done";

const STAGE_SET: ReadonlySet<unknown> = new Set(STAGES);

function isStage(value: unknown): value is Stage {
  return STAGE_SET.has(value);
}

export type { Stage, Status };
export { isStage, STAGES };
