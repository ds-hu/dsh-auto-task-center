/**
 * IANA wall-clock arithmetic with no dependencies.
 *
 * Every scheduled trigger is expressed as a wall-clock time in a named zone
 * (`daily`, `weekly`, `cron`) or as a plain instant (`at`, `every`). Node can
 * format an instant in a zone but cannot invert a wall clock back to an
 * instant, so this module supplies the inverse using `Intl.DateTimeFormat`
 * offsets, with the two rules the official DSH scheduler uses:
 *
 * - a local time that does not exist (spring-forward gap) is skipped;
 * - a local time that happens twice (autumn overlap) resolves to the earlier
 *   instant.
 *
 * @module @ds-hu/dsh-auto-task-center/lib/zoned
 */

const DAY_MS = 86_400_000;
const formatterCache = new Map();

/**
 * Whether a string names an IANA time zone this runtime understands.
 * @param {unknown} zone - Candidate zone id.
 * @returns {boolean} the answer.
 */
export function isValidTimeZone(zone) {
  if (typeof zone !== 'string' || zone === '') return false;
  if (zone === 'UTC') return true;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The cached formatter for one zone.
 * @param {string} timeZone - IANA zone id.
 * @returns {Intl.DateTimeFormat} a formatter with numeric parts and a 0-23 hour cycle.
 */
function formatterFor(timeZone) {
  let formatter = formatterCache.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/**
 * The calendar fields of one instant, as seen in a zone.
 * @param {string} timeZone - IANA zone id.
 * @param {number} utcMs - Epoch milliseconds.
 * @returns {{ year: number, month: number, day: number, hour: number, minute: number, second: number }} the fields.
 */
export function zoneParts(timeZone, utcMs) {
  /** @type {Record<string, string>} */
  const bag = {};
  for (const part of formatterFor(timeZone).formatToParts(utcMs)) {
    if (part.type !== 'literal') bag[part.type] = part.value;
  }
  return {
    year: Number(bag.year),
    month: Number(bag.month),
    day: Number(bag.day),
    hour: Number(bag.hour) % 24,
    minute: Number(bag.minute),
    second: Number(bag.second),
  };
}

/**
 * The zone's UTC offset at one instant.
 * @param {string} timeZone - IANA zone id.
 * @param {number} utcMs - Epoch milliseconds.
 * @returns {number} offset in milliseconds (east of UTC is positive).
 */
export function zoneOffsetMs(timeZone, utcMs) {
  const parts = zoneParts(timeZone, utcMs);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * Whether an instant renders as the given wall clock in the given zone.
 * @param {string} timeZone - IANA zone id.
 * @param {number} utcMs - Epoch milliseconds.
 * @param {{ year: number, month: number, day: number, hour: number, minute: number, second: number }} wall - Wall clock.
 * @returns {boolean} the answer.
 */
function rendersAs(timeZone, utcMs, wall) {
  const parts = zoneParts(timeZone, utcMs);
  return parts.year === wall.year
    && parts.month === wall.month
    && parts.day === wall.day
    && parts.hour === wall.hour
    && parts.minute === wall.minute
    && parts.second === wall.second;
}

/**
 * Every instant that renders as a wall clock in a zone, ascending.
 *
 * Zero results mean the wall clock falls in a spring-forward gap. Two results
 * mean it falls in an autumn overlap; callers that want one instant take the
 * first.
 *
 * @param {string} timeZone - IANA zone id.
 * @param {{ year: number, month: number, day: number, hour: number, minute: number, second?: number }} wall - Wall clock.
 * @returns {number[]} epoch milliseconds, ascending.
 */
export function wallClockToInstants(timeZone, wall) {
  const second = wall.second ?? 0;
  const target = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, second);
  const found = new Set();
  // Offsets are stable within a day either side, so probing three days covers
  // every transition that can affect this wall clock.
  for (const probe of [target - DAY_MS, target, target + DAY_MS]) {
    const candidate = target - zoneOffsetMs(timeZone, probe);
    if (rendersAs(timeZone, candidate, { ...wall, second })) found.add(candidate);
  }
  return [...found].sort((a, b) => a - b);
}

/**
 * The canonical instant of a wall clock, if it is still ahead of a boundary.
 *
 * A wall clock that happens twice (autumn overlap) fires once, at its earlier
 * instant: the canonical instant is the first one, and it is either ahead of
 * the boundary or the wall clock has already been served.
 *
 * @param {string} timeZone - IANA zone id.
 * @param {{ year: number, month: number, day: number, hour: number, minute: number, second?: number }} wall - Wall clock.
 * @param {number} afterMs - Exclusive lower bound.
 * @returns {number | undefined} epoch milliseconds, or undefined when the wall clock does not exist or is not ahead.
 */
export function firstInstantAfter(timeZone, wall, afterMs) {
  const [earliest] = wallClockToInstants(timeZone, wall);
  return earliest !== undefined && earliest > afterMs ? earliest : undefined;
}

/**
 * The next calendar date after one, in the proleptic Gregorian calendar.
 * @param {{ year: number, month: number, day: number }} date - Local date.
 * @returns {{ year: number, month: number, day: number }} the following date.
 */
export function nextLocalDate(date) {
  const probe = new Date(Date.UTC(date.year, date.month - 1, date.day));
  probe.setUTCDate(probe.getUTCDate() + 1);
  return { year: probe.getUTCFullYear(), month: probe.getUTCMonth() + 1, day: probe.getUTCDate() };
}

/**
 * ISO weekday (1 = Monday … 7 = Sunday) of a local date.
 * @param {{ year: number, month: number, day: number }} date - Local date.
 * @returns {number} the ISO weekday.
 */
export function isoWeekday(date) {
  const day = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  return day === 0 ? 7 : day;
}

/**
 * The first instant after a boundary whose local time is one of the given
 * hours and minutes and whose local date satisfies a predicate.
 *
 * @param {string} timeZone - IANA zone id.
 * @param {object} spec - What to look for.
 * @param {number[]} spec.hours - Allowed local hours, ascending.
 * @param {number[]} spec.minutes - Allowed local minutes, ascending.
 * @param {number} [spec.second] - Local second; defaults to 0.
 * @param {(date: { year: number, month: number, day: number }) => boolean} spec.matchDay - Local-date predicate.
 * @param {number} afterMs - Exclusive lower bound.
 * @param {number} [maxDays] - How many local days to scan; defaults to 4000 (covers 29 February).
 * @returns {number | undefined} epoch milliseconds, or undefined when nothing matches.
 */
export function nextWallClockAfter(timeZone, spec, afterMs, maxDays = 4000) {
  const second = spec.second ?? 0;
  const hours = [...spec.hours].sort((a, b) => a - b);
  const minutes = [...spec.minutes].sort((a, b) => a - b);
  let date = zoneParts(timeZone, afterMs);
  date = { year: date.year, month: date.month, day: date.day };
  for (let dayIndex = 0; dayIndex < maxDays; dayIndex += 1) {
    if (spec.matchDay(date)) {
      for (const hour of hours) {
        for (const minute of minutes) {
          const instant = firstInstantAfter(timeZone, { ...date, hour, minute, second }, afterMs);
          if (instant !== undefined) return instant;
        }
      }
    }
    date = nextLocalDate(date);
  }
  return undefined;
}
