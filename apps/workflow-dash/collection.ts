const collectionConcurrency = 4;

/** Preserve source ordering while bounding concurrent collection work. */
async function collect<T, R>(
  items: readonly T[],
  read: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  async function worker(): Promise<void> {
    const index = next;
    next += 1;
    if (index >= items.length) {
      return;
    }
    results[index] = await read(items[index]);
    await worker();
  }
  await Promise.all(
    Array.from(
      { length: Math.min(collectionConcurrency, items.length) },
      worker,
    ),
  );
  return results;
}

export { collect };
