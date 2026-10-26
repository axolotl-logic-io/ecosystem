import type { Timestamp } from "./source-records.ts";

const millisecondsPerSecond = 1000;

function ms(value: Timestamp): number {
  if (typeof value === "number") {
    return value;
  }
  if (value === undefined || value === null) {
    return 0;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return 0;
  }
  return parsed;
}
function today(value: Timestamp, now = Date.now()): boolean {
  return new Date(ms(value)).toDateString() === new Date(now).toDateString();
}
function seconds(start: Timestamp, end: Timestamp): number {
  return Math.max(0, (ms(end) - ms(start)) / millisecondsPerSecond);
}
function elapsed(start: Timestamp, end: Timestamp = Date.now()): number {
  return seconds(start, end);
}

export { elapsed, ms, today };
