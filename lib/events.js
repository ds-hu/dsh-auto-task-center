/**
 * The event model: one vocabulary for *why* a run happened.
 *
 * A task owns exactly one **trigger** — a schedule, an HTTP address, or nothing
 * at all — and every firing is an **event** that names its source explicitly.
 * That split is what lets a scheduled task also be run by hand without
 * pretending the schedule fired, and what lets a manual-only task exist at all.
 *
 * Three sources cover every way a run can start:
 *
 * | Source     | Caused by                                              |
 * |------------|--------------------------------------------------------|
 * | `schedule` | the timer reaching a task's next occurrence            |
 * | `http`     | a request to a webhook task's address                  |
 * | `manual`   | a person pressing Run now, or an agent calling the tool |
 *
 * @module @ds-hu/dsh-auto-task-center/lib/events
 */

/** Every way a run can be caused, in the order the panel shows them. */
export const EVENT_SOURCES = Object.freeze(['schedule', 'http', 'manual']);

/** The task-level trigger kinds, per source. */
const SOURCE_BY_KIND = Object.freeze({
  at: 'schedule',
  every: 'schedule',
  daily: 'schedule',
  weekly: 'schedule',
  cron: 'schedule',
  webhook: 'http',
  manual: 'manual',
});

/**
 * Which source a task's trigger belongs to.
 * @param {string} kind - Trigger kind.
 * @returns {'schedule' | 'http' | 'manual'} the source.
 */
export function sourceOfTrigger(kind) {
  return SOURCE_BY_KIND[kind] ?? 'schedule';
}

/**
 * Whether a trigger waits for an external act instead of the clock.
 *
 * Such a task has no next occurrence: it is enabled and idle, which the panel
 * says differently from "not scheduled yet".
 *
 * @param {string} kind - Trigger kind.
 * @returns {boolean} true for `webhook` and `manual`.
 */
export function waitsForEvent(kind) {
  return sourceOfTrigger(kind) !== 'schedule';
}

/**
 * Build the event that starts one run.
 *
 * The object is deliberately plain data: it crosses the scheduler, the run
 * record and the HTTP layer unchanged, so a record can always be traced back to
 * the act that caused it.
 *
 * @param {object} input - Event fields.
 * @param {'schedule' | 'http' | 'manual'} input.source - What caused the run.
 * @param {number} input.at - Clock reading of the cause.
 * @param {string} [input.payload] - HTTP request body, for `http` events.
 * @param {string} [input.actor] - Who asked, for `manual` events (`panel`, `tool`, `cli`).
 * @returns {{ source: string, at: string, payload?: string, actor?: string }} the event.
 */
export function createEvent({ source, at, payload, actor }) {
  return {
    source,
    at: new Date(at).toISOString(),
    ...(payload === undefined || payload === '' ? {} : { payload }),
    ...(actor === undefined || actor === '' ? {} : { actor }),
  };
}

/**
 * One short human sentence describing an event, for logs and run details.
 * @param {{ source: string, actor?: string }} event - The event.
 * @returns {string} e.g. `scheduled run`, `HTTP request`, `manual run (panel)`.
 */
export function describeEvent(event) {
  if (event.source === 'http') return 'HTTP request';
  if (event.source === 'manual') return `manual run${event.actor === undefined ? '' : ` (${event.actor})`}`;
  return 'scheduled run';
}
