/**
 * The five-field cron dialect, parsed and evaluated with no dependencies.
 *
 * The accepted grammar is deliberately the same subset the official DSH
 * reminder tools accept, so a task moved between the two keeps working:
 * five fields, `*`, a value, `a-b`, a step suffix, and comma lists. `L`, `W`,
 * `#`, month and weekday names, `@macros` and six-field expressions are
 * rejected with a message that names the offending field.
 *
 * @module @ds-hu/dsh-auto-task-center/lib/cron
 */
import { isoWeekday, nextWallClockAfter } from './zoned.js';

/** Field order and inclusive bounds. */
const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day-of-week', min: 0, max: 7 },
];

/** A cron expression this module refuses. */
export class CronError extends Error {
  /**
   * @param {string} message - Human-readable explanation naming the field.
   */
  constructor(message) {
    super(message);
    this.name = 'CronError';
    this.code = 'trigger/cron-invalid';
  }
}

/**
 * Expand one cron field into its allowed values.
 * @param {string} text - The raw field.
 * @param {{ name: string, min: number, max: number }} field - Field metadata.
 * @returns {number[]} allowed values, ascending, deduplicated.
 */
function parseField(text, field) {
  if (text === '') throw new CronError(`${field.name} is empty`);
  const values = new Set();
  for (const item of text.split(',')) {
    if (item === '') throw new CronError(`${field.name} has an empty list item`);
    const [rangeText, stepText, extra] = item.split('/');
    if (extra !== undefined) throw new CronError(`${field.name} item "${item}" has more than one step`);
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/u.test(stepText)) throw new CronError(`${field.name} step "${stepText}" is not a number`);
      step = Number(stepText);
      if (step < 1) throw new CronError(`${field.name} step must be at least 1`);
    }
    let low;
    let high;
    if (rangeText === '*') {
      low = field.min;
      high = field.max;
    } else if (rangeText.includes('-')) {
      const bounds = rangeText.split('-');
      if (bounds.length !== 2) throw new CronError(`${field.name} range "${rangeText}" is malformed`);
      for (const bound of bounds) {
        if (!/^\d+$/u.test(bound)) throw new CronError(`${field.name} range bound "${bound}" is not a number`);
      }
      low = Number(bounds[0]);
      high = Number(bounds[1]);
    } else {
      if (!/^\d+$/u.test(rangeText)) throw new CronError(`${field.name} value "${rangeText}" is not a number`);
      low = Number(rangeText);
      // `a/n` means "from a to the end, every n".
      high = stepText === undefined ? low : field.max;
    }
    if (low < field.min || high > field.max || low > high) {
      throw new CronError(`${field.name} must stay within ${field.min}-${field.max} (got "${item}")`);
    }
    for (let value = low; value <= high; value += step) values.add(value);
  }
  return [...values].sort((a, b) => a - b);
}

/**
 * Parse a five-field cron expression.
 * @param {string} expression - Candidate expression.
 * @returns {{ minutes: number[], hours: number[], days: number[], months: number[], weekdays: number[], dayOfMonthRestricted: boolean, dayOfWeekRestricted: boolean }} the parsed expression.
 * @throws {CronError} when the expression is outside the dialect.
 */
export function parseCron(expression) {
  if (typeof expression !== 'string') throw new CronError('a cron expression must be a string');
  const trimmed = expression.trim().replaceAll(/\s+/gu, ' ');
  if (trimmed === '') throw new CronError('a cron expression must not be empty');
  if (trimmed.startsWith('@')) {
    throw new CronError('@macros are not supported; write the five fields explicitly');
  }
  const fields = trimmed.split(' ');
  if (fields.length !== 5) {
    throw new CronError(`expected 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}`);
  }
  const [minutes, hours, days, months, weekdays] = fields.map((text, index) => parseField(text, FIELDS[index]));
  return {
    minutes,
    hours,
    days,
    months,
    weekdays,
    dayOfMonthRestricted: fields[2] !== '*',
    dayOfWeekRestricted: fields[4] !== '*',
  };
}

/**
 * Whether a local date matches the day fields of a parsed expression.
 *
 * The standard rule: when both day fields are restricted a date matches if
 * either matches; when only one is restricted that one decides; when neither
 * is, every date matches.
 *
 * @param {ReturnType<typeof parseCron>} parsed - Parsed expression.
 * @param {{ year: number, month: number, day: number }} date - Local date.
 * @returns {boolean} the answer.
 */
export function cronMatchesDate(parsed, date) {
  if (!parsed.months.includes(date.month)) return false;
  const sundayBased = isoWeekday(date) % 7;
  const dayOfMonthOk = parsed.days.includes(date.day);
  const dayOfWeekOk = parsed.weekdays.includes(sundayBased) || (sundayBased === 0 && parsed.weekdays.includes(7));
  if (parsed.dayOfMonthRestricted && parsed.dayOfWeekRestricted) return dayOfMonthOk || dayOfWeekOk;
  if (parsed.dayOfMonthRestricted) return dayOfMonthOk;
  if (parsed.dayOfWeekRestricted) return dayOfWeekOk;
  return true;
}

/**
 * The first instant after a boundary that matches a cron expression.
 * @param {ReturnType<typeof parseCron>} parsed - Parsed expression.
 * @param {string} timeZone - IANA zone id.
 * @param {number} afterMs - Exclusive lower bound.
 * @returns {number | undefined} epoch milliseconds, or undefined when nothing matches within five years.
 */
export function nextCronAfter(parsed, timeZone, afterMs) {
  return nextWallClockAfter(timeZone, {
    hours: parsed.hours,
    minutes: parsed.minutes,
    matchDay: (date) => cronMatchesDate(parsed, date),
  }, afterMs);
}
