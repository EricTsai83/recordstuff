/**
 * `Promise.all(items.map(run))` with at most `limit` runs in flight, the results in the items' order. For file-system
 * fan-outs over folders of unknown size: libuv works through only four requests at a time, so thousands queued at once
 * make every other read and write in main (the log, a session's sentinel, a save) wait behind them. A run that rejects
 * rejects the whole, as Promise.all does; runs already started still finish.
 */
export async function mapLimited<T, R>(items: readonly T[], limit: number, run: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}
