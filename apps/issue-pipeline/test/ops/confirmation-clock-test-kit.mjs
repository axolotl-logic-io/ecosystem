// @ts-check
// Virtual monotonic time: no real waiting or production clock replacement.
/** @param {number} [started] */
function confirmationClock(started = 0) {
  let elapsed = started;
  /** @type {number[]} */
  const waits = [];
  return {
    now: () => elapsed,
    /** @param {number} ms */
    sleep(ms) {
      waits.push(ms);
      elapsed += ms;
    },
    waits,
  };
}

export { confirmationClock };
