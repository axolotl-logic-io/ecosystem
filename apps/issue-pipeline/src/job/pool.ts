// A bounded pool for the stage job's batches: every item runs, at most
// `limit` at once, and the results come back in the items' order.

// Runs `run` on each item with at most `limit` (at least 1) running at once,
// starting each item as soon as a running one finishes. Resolves to the
// results in the items' order.
async function runAll<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  const queue = items.entries();
  async function worker(): Promise<void> {
    const entry = queue.next();
    if (entry.done === true) {
      return;
    }
    const [index, item] = entry.value;
    results[index] = await run(item);
    await worker();
  }
  const width = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: width }, worker));
  return results;
}

export { runAll };
