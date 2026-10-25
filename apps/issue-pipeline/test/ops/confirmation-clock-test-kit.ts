// Virtual monotonic time: no real waiting or production clock replacement.
function confirmationClock(started = 0): {
  now: () => number;
  sleep: (ms: number) => void;
  waits: number[];
} {
  let elapsed = started;
  const waits: number[] = [];
  return {
    now: (): number => elapsed,
    sleep(ms: number): void {
      waits.push(ms);
      elapsed += ms;
    },
    waits,
  };
}

export { confirmationClock };
