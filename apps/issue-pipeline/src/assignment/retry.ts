import { OpsError } from "../ops-error.ts";

const MS_PER_SECOND = 1000;
const RETRY_AFTER = /^retry-after:\s*(?<value>.+)$/imu;
const RESET = /^x-ratelimit-reset:\s*(?<value>\d+)$/imu;
class RetryHold extends OpsError {
  readonly until: number;
  constructor(message: string, options: ErrorOptions & { until: number }) {
    super(message, options);
    this.until = options.until;
  }
}
function retryTime(headers: string, now: number): number {
  const { value } = RETRY_AFTER.exec(headers)?.groups ?? {};
  const { value: reset } = RESET.exec(headers)?.groups ?? {};
  let until = now;
  if (value !== undefined) {
    let parsed = Date.parse(value);
    if (Number.isFinite(Number(value))) {
      parsed = now + Number(value) * MS_PER_SECOND;
    }
    if (Number.isFinite(parsed)) {
      until = Math.max(until, parsed);
    }
  }
  if (reset !== undefined) {
    until = Math.max(until, Number(reset) * MS_PER_SECOND);
  }
  return until;
}

export { RetryHold, retryTime };
