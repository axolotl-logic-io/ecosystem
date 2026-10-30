// Cooperative launcher shutdown and interruptible polling.
import process from "node:process";

const SIGNALS = ["SIGTERM", "SIGINT"] as const;
function openStop(): { buddy: AbortSignal; close: () => void } {
  const controller = new AbortController();
  function stop(signal: string): void {
    controller.abort(`${signal} received`);
  }
  for (const signal of SIGNALS) {
    process.on(signal, stop);
  }
  return {
    buddy: controller.signal,
    close: (): void => {
      for (const signal of SIGNALS) {
        process.off(signal, stop);
      }
    },
  };
}
// Resolves after `ms`, or as soon as `signal` aborts.
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve: () => void): void => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export { openStop, pause };
