/**
 * Occurrence arithmetic: when does a trigger fire next, and how many times did
 * it fire while the Host was not looking.
 *
 * Pure functions over stored triggers — no clock, no I/O — so the schedule
 * rules can be tested exhaustively without a running Host.
 *
 * @module @ds-hu/dsh-auto-task-center/lib/engine
 */
import { parseCron, nextCronAfter } from './cron.js';
import { isoWeekday, nextWallClockAfter } from './zoned.js';

/**
 * Parse the `HH:mm:ss` time of day of a wall-clock trigger.
 * @param {string} time - Stored time.
 * @returns {{ hour: number, minute: number, second: number }} the fields.
 */
function timeOfDay(time) {
  const [hour, minute, second] = time.split(':').map(Number);
  return { hour, minute, second };
}

/**
 * The first instant strictly after a boundary at which a trigger fires.
 *
 * `webhook` never fires on its own, so it has no next occurrence. `at` returns
 * its single instant only while that instant is still ahead.
 *
 * @param {Record<string, any>} trigger - Stored trigger.
 * @param {number} fromMs - Exclusive lower bound.
 * @returns {number | undefined} epoch milliseconds, or undefined when the trigger has no future occurrence.
 */
export function nextOccurrence(trigger, fromMs) {
  switch (trigger?.kind) {
    case 'at': {
      const at = Date.parse(trigger.at);
      return Number.isFinite(at) && at > fromMs ? at : undefined;
    }
    case 'every': {
      const anchor = Date.parse(trigger.anchorAt);
      const interval = trigger.everySeconds * 1000;
      if (!Number.isFinite(anchor) || !Number.isFinite(interval) || interval <= 0) return undefined;
      if (fromMs < anchor) return anchor;
      return anchor + (Math.floor((fromMs - anchor) / interval) + 1) * interval;
    }
    case 'daily': {
      const { hour, minute, second } = timeOfDay(trigger.time);
      return nextWallClockAfter(trigger.timeZone, {
        hours: [hour],
        minutes: [minute],
        second,
        matchDay: () => true,
      }, fromMs);
    }
    case 'weekly': {
      const { hour, minute, second } = timeOfDay(trigger.time);
      return nextWallClockAfter(trigger.timeZone, {
        hours: [hour],
        minutes: [minute],
        second,
        matchDay: (date) => trigger.weekdays.includes(isoWeekday(date)),
      }, fromMs);
    }
    case 'cron':
      return nextCronAfter(parseCron(trigger.expression), trigger.timeZone, fromMs);
    case 'webhook':
      return undefined;
    default:
      return undefined;
  }
}

/**
 * The occurrences a trigger had in a half-open window `(afterMs, throughMs]`.
 *
 * Used to report what was skipped while the Host was down. The count is capped
 * so a very old `evaluatedThrough` watermark cannot stall startup; `truncated`
 * says whether the cap was hit.
 *
 * @param {Record<string, any>} trigger - Stored trigger.
 * @param {number} afterMs - Exclusive lower bound.
 * @param {number} throughMs - Inclusive upper bound.
 * @param {number} [cap] - Maximum occurrences to walk; defaults to 500.
 * @returns {{ count: number, last: number | undefined, truncated: boolean }} the window summary.
 */
export function countOccurrences(trigger, afterMs, throughMs, cap = 500) {
  if (!(throughMs > afterMs)) return { count: 0, last: undefined, truncated: false };
  if (trigger?.kind === 'every') {
    const anchor = Date.parse(trigger.anchorAt);
    const interval = trigger.everySeconds * 1000;
    const first = nextOccurrence(trigger, afterMs);
    if (first === undefined || first > throughMs) return { count: 0, last: undefined, truncated: false };
    const last = anchor + Math.floor((throughMs - anchor) / interval) * interval;
    const count = Math.floor((last - first) / interval) + 1;
    return { count, last, truncated: false };
  }
  let count = 0;
  let last;
  let cursor = afterMs;
  while (count < cap) {
    const next = nextOccurrence(trigger, cursor);
    if (next === undefined || next > throughMs) return { count, last, truncated: false };
    count += 1;
    last = next;
    cursor = next;
  }
  return { count, last, truncated: true };
}

/**
 * The next few occurrences of a trigger, for the panel's preview.
 * @param {Record<string, any>} trigger - Stored trigger.
 * @param {number} fromMs - Exclusive lower bound.
 * @param {number} [limit] - How many to list; defaults to 5.
 * @returns {string[]} ISO instants.
 */
export function previewOccurrences(trigger, fromMs, limit = 5) {
  const out = [];
  let cursor = fromMs;
  for (let index = 0; index < limit; index += 1) {
    const next = nextOccurrence(trigger, cursor);
    if (next === undefined) break;
    out.push(new Date(next).toISOString());
    cursor = next;
  }
  return out;
}
