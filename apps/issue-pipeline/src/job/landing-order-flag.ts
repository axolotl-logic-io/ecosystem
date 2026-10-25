// The landing order flag of job.mjs and the caller's launcher. #166 renamed
// `--merge-queue` to `--landing-order`; either is read, never both.

interface OrderFlags {
  "landing-order"?: string | undefined;
  "merge-queue"?: string | undefined;
}

// The landing order `values` give, or undefined when they give none; throws
// when both flags are set.
function landingOrderFlag(values: OrderFlags): string | undefined {
  const { "landing-order": order, "merge-queue": queue } = values;
  if (order !== undefined && queue !== undefined) {
    throw new Error(
      "--merge-queue is the old name of --landing-order; give only --landing-order",
    );
  }
  return order ?? queue;
}

export { landingOrderFlag };
