export const TASK_POLL_INTERVAL_SECONDS = 20;

export interface TaskPollTiming {
  last_polled_at?: string;
  poll_in_flight_until?: string;
}

/** Measure the cooldown from a successful response, rather than request start. */
export function remainingPollSeconds(task: TaskPollTiming): number {
  const completed = Date.parse(task.last_polled_at ?? '');
  const inFlight = Date.parse(task.poll_in_flight_until ?? '');
  const next = Math.max(Number.isFinite(completed) ? completed + TASK_POLL_INTERVAL_SECONDS * 1000 : 0,
    Number.isFinite(inFlight) ? inFlight : 0);
  return Math.max(0, Math.ceil((next - Date.now()) / 1000));
}

export function pollAfterSeconds(task: TaskPollTiming & { status: string }, cached = false): number | undefined {
  if (['submitting', 'submission_unknown'].includes(task.status)) return undefined;
  const remaining = remainingPollSeconds(task);
  if (cached && remaining) return Math.min(remaining, TASK_POLL_INTERVAL_SECONDS);
  return ['queued', 'running', 'partially_completed', 'unknown'].includes(task.status)
    ? Math.min(remaining || TASK_POLL_INTERVAL_SECONDS, TASK_POLL_INTERVAL_SECONDS) : undefined;
}
