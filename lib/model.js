/**
 * Task record shape, validation and normalization.
 *
 * A task is a plain JSON object. This module is the only place that decides
 * whether a draft is acceptable; the store, the HTTP API and the agent tool all
 * funnel through {@link normalizeDraft} so the panel and the model cannot drift
 * apart.
 *
 * @module @ds-hu/dsh-auto-task-center/lib/model
 */
import { randomUUID } from 'node:crypto';
import { parseCron } from './cron.js';
import { isValidTimeZone } from './zoned.js';

/** Newest-first run records kept per task. */
export const MAX_HISTORY = 50;
/** Longest accepted task name, in characters. */
export const MAX_NAME_LENGTH = 120;
/** Longest accepted message body, in characters. */
export const MAX_MESSAGE_LENGTH = 16 * 1024;
/** Shortest accepted fixed interval, in seconds. */
export const MIN_EVERY_SECONDS = 60;
/** Trigger kinds, in the order the panel lists them. */
export const TRIGGER_KINDS = Object.freeze(['at', 'every', 'daily', 'weekly', 'cron', 'webhook']);
/** Target kinds. */
export const TARGET_KINDS = Object.freeze(['newSession', 'session']);
/** Run results. */
export const RUN_RESULTS = Object.freeze(['ok', 'failed', 'missed']);

/** A rejected draft: a stable code plus a message safe to show a user. */
export class TaskInputError extends Error {
  /**
   * @param {string} code - Stable machine code, e.g. `trigger/invalid`.
   * @param {string} message - Human-readable explanation.
   */
  constructor(code, message) {
    super(message);
    this.name = 'TaskInputError';
    this.code = code;
  }
}

/** @returns {string} A fresh task identity. */
export function newTaskId() {
  return `task-${randomUUID()}`;
}

/** @returns {string} A fresh 32-hex webhook secret. */
export function newSecret() {
  return randomUUID().replaceAll('-', '');
}

/**
 * Whether a value is a plain object (not an array, not null).
 * @param {unknown} value - Candidate.
 * @returns {boolean} the answer.
 */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read one required string field.
 * @param {Record<string, unknown>} source - Object to read from.
 * @param {string} key - Field name.
 * @param {string} code - Error code to raise when absent or wrong.
 * @returns {string} the trimmed value.
 */
function requireString(source, key, code) {
  const value = source[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TaskInputError(code, `${key} must be a non-empty string`);
  }
  return value.trim();
}

/**
 * Normalize `HH:mm` or `HH:mm:ss` to `HH:mm:ss`.
 * @param {unknown} value - Candidate wall-clock time.
 * @returns {string} the normalized time.
 */
function normalizeTimeOfDay(value) {
  if (typeof value !== 'string') {
    throw new TaskInputError('trigger/time-invalid', 'time must be a string such as 09:00');
  }
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/u.exec(value.trim());
  if (match === null) {
    throw new TaskInputError('trigger/time-invalid', 'time must look like HH:mm or HH:mm:ss');
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = match[3] === undefined ? 0 : Number(match[3]);
  if (hour > 23 || minute > 59 || second > 59) {
    throw new TaskInputError('trigger/time-invalid', 'time is outside the 24-hour clock');
  }
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`;
}

/**
 * Read a required IANA time zone.
 * @param {Record<string, unknown>} source - Object to read from.
 * @returns {string} the zone id.
 */
function requireTimeZone(source) {
  const zone = requireString(source, 'timeZone', 'trigger/time-zone-invalid');
  if (!isValidTimeZone(zone)) {
    throw new TaskInputError('trigger/time-zone-invalid', `${zone} is not an IANA time zone`);
  }
  return zone;
}

/**
 * Read an ISO instant.
 * @param {unknown} value - Candidate.
 * @param {string} code - Error code to raise.
 * @returns {number} epoch milliseconds.
 */
function readInstant(value, code) {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new TaskInputError(code, 'expected an ISO 8601 instant');
  }
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new TaskInputError(code, 'expected an ISO 8601 instant');
  }
  return ms;
}

/**
 * Validate and normalize one trigger.
 * @param {unknown} raw - Candidate trigger.
 * @param {number} nowMs - Creation instant, used for anchors and secrets.
 * @param {object} [existing] - The stored trigger when updating.
 * @returns {Record<string, unknown>} the stored trigger.
 */
function normalizeTrigger(raw, nowMs, existing) {
  if (!isObject(raw)) throw new TaskInputError('trigger/missing', 'trigger is required');
  const kind = raw.kind;
  if (typeof kind !== 'string' || !TRIGGER_KINDS.includes(kind)) {
    throw new TaskInputError('trigger/unknown-kind', `trigger.kind must be one of ${TRIGGER_KINDS.join(', ')}`);
  }
  switch (kind) {
    case 'at': {
      const at = readInstant(raw.at, 'trigger/at-invalid');
      if (at <= nowMs) throw new TaskInputError('trigger/at-past', 'at must be in the future');
      return { kind, at: new Date(at).toISOString() };
    }
    case 'every': {
      const seconds = raw.everySeconds;
      if (!Number.isInteger(seconds) || seconds < MIN_EVERY_SECONDS) {
        throw new TaskInputError('trigger/every-invalid', `everySeconds must be an integer of at least ${MIN_EVERY_SECONDS}`);
      }
      const anchor = raw.anchorAt === undefined
        ? (existing?.kind === 'every' && typeof existing.anchorAt === 'string' ? Date.parse(existing.anchorAt) : nowMs)
        : readInstant(raw.anchorAt, 'trigger/every-invalid');
      return { kind, everySeconds: seconds, anchorAt: new Date(anchor).toISOString() };
    }
    case 'daily':
      return { kind, time: normalizeTimeOfDay(raw.time), timeZone: requireTimeZone(raw) };
    case 'weekly': {
      const time = normalizeTimeOfDay(raw.time);
      const timeZone = requireTimeZone(raw);
      const weekdays = raw.weekdays;
      if (!Array.isArray(weekdays) || weekdays.length === 0) {
        throw new TaskInputError('trigger/weekdays-invalid', 'weekdays must be a non-empty array');
      }
      const days = [...new Set(weekdays)].sort((a, b) => a - b);
      for (const day of days) {
        if (!Number.isInteger(day) || day < 1 || day > 7) {
          throw new TaskInputError('trigger/weekdays-invalid', 'weekdays use ISO numbers 1 (Monday) through 7 (Sunday)');
        }
      }
      return { kind, time, timeZone, weekdays: days };
    }
    case 'cron': {
      const expression = requireString(raw, 'expression', 'trigger/cron-invalid').replaceAll(/\s+/gu, ' ');
      try {
        parseCron(expression);
      } catch (error) {
        throw new TaskInputError('trigger/cron-invalid', error?.message ?? 'invalid cron expression');
      }
      return { kind, expression, timeZone: requireTimeZone(raw) };
    }
    case 'webhook': {
      const reuse = existing?.kind === 'webhook' && typeof existing.secret === 'string' && /^[0-9a-f]{32}$/u.test(existing.secret)
        ? existing.secret
        : undefined;
      const secret = typeof raw.secret === 'string' && /^[0-9a-f]{32}$/u.test(raw.secret) ? raw.secret : (reuse ?? newSecret());
      return { kind, secret };
    }
    default:
      throw new TaskInputError('trigger/unknown-kind', 'unreachable');
  }
}

/**
 * Validate and normalize one delivery target.
 * @param {unknown} raw - Candidate target.
 * @returns {Record<string, unknown>} the stored target.
 */
function normalizeTarget(raw) {
  if (!isObject(raw)) throw new TaskInputError('target/missing', 'target is required');
  const kind = raw.kind;
  if (kind === 'newSession') {
    const workspaceId = typeof raw.workspaceId === 'string' && raw.workspaceId.trim() !== '' ? raw.workspaceId.trim() : undefined;
    const cwd = typeof raw.cwd === 'string' && raw.cwd.trim() !== '' ? raw.cwd.trim() : undefined;
    if (workspaceId !== undefined && cwd !== undefined) {
      throw new TaskInputError('target/ambiguous', 'name a workspace or a directory, not both');
    }
    if (workspaceId === undefined && cwd === undefined) {
      throw new TaskInputError('target/missing', 'a new session needs a workspace or a directory');
    }
    if (cwd !== undefined && !cwd.startsWith('/') && !/^[A-Za-z]:[\\/]/u.test(cwd)) {
      throw new TaskInputError('target/cwd-invalid', 'cwd must be an absolute path');
    }
    const agentPreset = typeof raw.agentPreset === 'string' && raw.agentPreset.trim() !== '' ? raw.agentPreset.trim() : undefined;
    return {
      kind,
      ...(workspaceId === undefined ? {} : { workspaceId }),
      ...(cwd === undefined ? {} : { cwd }),
      ...(agentPreset === undefined ? {} : { agentPreset }),
    };
  }
  if (kind === 'session') {
    return { kind, sessionId: requireString(raw, 'sessionId', 'target/session-invalid') };
  }
  throw new TaskInputError('target/unknown-kind', `target.kind must be one of ${TARGET_KINDS.join(', ')}`);
}

/**
 * Validate and normalize one message.
 * @param {unknown} raw - Candidate message.
 * @returns {{ text: string, goalMode: boolean }} the stored message.
 */
function normalizeMessage(raw) {
  if (!isObject(raw)) throw new TaskInputError('message/missing', 'message is required');
  const text = typeof raw.text === 'string' ? raw.text : '';
  if (text.trim() === '') throw new TaskInputError('message/empty', 'message text must not be empty');
  if (text.length > MAX_MESSAGE_LENGTH) {
    throw new TaskInputError('message/too-long', `message text must stay under ${MAX_MESSAGE_LENGTH} characters`);
  }
  return { text, goalMode: raw.goalMode === true };
}

/**
 * Turn a draft into a storable record.
 *
 * Updating keeps the identity, creation time, history and run bookkeeping of
 * the stored record; everything the user can edit comes from the draft.
 *
 * @param {unknown} draft - Untrusted draft from the panel or the agent tool.
 * @param {object} [options] - Normalization context.
 * @param {number} [options.nowMs] - Clock reading; defaults to `Date.now()`.
 * @param {Record<string, any>} [options.existing] - Stored record when updating.
 * @returns {Record<string, any>} the complete record.
 * @throws {TaskInputError} when the draft is not acceptable.
 */
export function normalizeDraft(draft, { nowMs = Date.now(), existing } = {}) {
  if (!isObject(draft)) throw new TaskInputError('draft/invalid', 'a task draft must be an object');
  const name = requireString(draft, 'name', 'name/invalid');
  if (name.length > MAX_NAME_LENGTH) {
    throw new TaskInputError('name/too-long', `name must stay under ${MAX_NAME_LENGTH} characters`);
  }
  const enabled = draft.enabled === undefined ? true : draft.enabled === true;
  const trigger = normalizeTrigger(draft.trigger, nowMs, existing?.trigger);
  const target = normalizeTarget(draft.target);
  const message = normalizeMessage(draft.message);
  const iso = new Date(nowMs).toISOString();
  const base = existing ?? {};
  return {
    id: typeof base.id === 'string' ? base.id : newTaskId(),
    name,
    enabled,
    trigger,
    target,
    message,
    state: {
      status: enabled ? 'active' : 'inactive',
      ...(base.state?.nextAt === undefined ? {} : { nextAt: base.state.nextAt }),
      evaluatedThrough: typeof base.state?.evaluatedThrough === 'string' ? base.state.evaluatedThrough : iso,
      ...(base.state?.lastRunAt === undefined ? {} : { lastRunAt: base.state.lastRunAt }),
      ...(base.state?.lastResult === undefined ? {} : { lastResult: base.state.lastResult }),
      consecutiveFailures: Number.isInteger(base.state?.consecutiveFailures) ? base.state.consecutiveFailures : 0,
      needsAttention: base.state?.needsAttention === true,
    },
    history: Array.isArray(base.history) ? base.history.slice(0, MAX_HISTORY) : [],
    createdAt: typeof base.createdAt === 'string' ? base.createdAt : iso,
    updatedAt: iso,
  };
}

/**
 * Append one run record, newest first, capped at {@link MAX_HISTORY}.
 * @param {Record<string, any>} task - Record to mutate.
 * @param {{ at: string, result: string, detail: string, sessionId?: string }} run - Run outcome.
 * @returns {Record<string, any>} the same record.
 */
export function appendHistory(task, run) {
  const entry = {
    runId: `run-${randomUUID()}`,
    at: run.at,
    result: run.result,
    detail: run.detail,
    ...(run.code === undefined ? {} : { code: run.code }),
    ...(run.params === undefined ? {} : { params: run.params }),
    ...(run.sessionId === undefined ? {} : { sessionId: run.sessionId }),
  };
  task.history = [entry, ...(Array.isArray(task.history) ? task.history : [])].slice(0, MAX_HISTORY);
  task.state = { ...task.state, lastRunAt: entry.at, lastResult: entry.result };
  return task;
}

/** A stored identity looks like `task-<uuid>`. */
const ID_SHAPE = /^task-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SECRET_SHAPE = /^[0-9a-f]{32}$/u;
const TIME_SHAPE = /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/u;

/**
 * Re-validate one stored trigger without rejecting history.
 *
 * Unlike {@link normalizeDraft} this accepts an `at` instant that is already
 * past, because a stored one-shot may legitimately have expired while the Host
 * was down.
 *
 * @param {unknown} raw - Stored trigger.
 * @returns {Record<string, any> | null} the trigger, or null when unusable.
 */
function sanitizeStoredTrigger(raw) {
  if (!isObject(raw) || typeof raw.kind !== 'string' || !TRIGGER_KINDS.includes(raw.kind)) return null;
  switch (raw.kind) {
    case 'at':
      return Number.isFinite(Date.parse(raw.at)) ? { kind: 'at', at: new Date(Date.parse(raw.at)).toISOString() } : null;
    case 'every':
      return Number.isInteger(raw.everySeconds) && raw.everySeconds >= MIN_EVERY_SECONDS && Number.isFinite(Date.parse(raw.anchorAt))
        ? { kind: 'every', everySeconds: raw.everySeconds, anchorAt: new Date(Date.parse(raw.anchorAt)).toISOString() }
        : null;
    case 'daily':
      return TIME_SHAPE.test(raw.time) && isValidTimeZone(raw.timeZone)
        ? { kind: 'daily', time: raw.time, timeZone: raw.timeZone }
        : null;
    case 'weekly':
      return TIME_SHAPE.test(raw.time)
        && isValidTimeZone(raw.timeZone)
        && Array.isArray(raw.weekdays)
        && raw.weekdays.length > 0
        && raw.weekdays.every((day) => Number.isInteger(day) && day >= 1 && day <= 7)
        ? { kind: 'weekly', time: raw.time, timeZone: raw.timeZone, weekdays: [...new Set(raw.weekdays)].sort((a, b) => a - b) }
        : null;
    case 'cron': {
      if (!isValidTimeZone(raw.timeZone) || typeof raw.expression !== 'string') return null;
      try {
        parseCron(raw.expression);
      } catch {
        return null;
      }
      return { kind: 'cron', expression: raw.expression, timeZone: raw.timeZone };
    }
    case 'webhook':
      return SECRET_SHAPE.test(raw.secret) ? { kind: 'webhook', secret: raw.secret } : null;
    default:
      return null;
  }
}

/**
 * Re-validate one stored target.
 * @param {unknown} raw - Stored target.
 * @returns {Record<string, any> | null} the target, or null when unusable.
 */
function sanitizeStoredTarget(raw) {
  if (!isObject(raw)) return null;
  if (raw.kind === 'newSession') {
    const workspaceId = typeof raw.workspaceId === 'string' && raw.workspaceId !== '' ? raw.workspaceId : undefined;
    const cwd = typeof raw.cwd === 'string' && raw.cwd !== '' ? raw.cwd : undefined;
    if ((workspaceId === undefined) === (cwd === undefined)) return null;
    const agentPreset = typeof raw.agentPreset === 'string' && raw.agentPreset !== '' ? raw.agentPreset : undefined;
    return { kind: 'newSession', ...(workspaceId === undefined ? {} : { workspaceId }), ...(cwd === undefined ? {} : { cwd }), ...(agentPreset === undefined ? {} : { agentPreset }) };
  }
  if (raw.kind === 'session') {
    return typeof raw.sessionId === 'string' && raw.sessionId !== '' ? { kind: 'session', sessionId: raw.sessionId } : null;
  }
  return null;
}

/**
 * Repair one record read back from disk.
 *
 * Loading must never fail because of a single damaged record, so anything
 * structurally wrong is dropped and everything merely missing is defaulted.
 *
 * @param {unknown} raw - Candidate record from the store file.
 * @returns {Record<string, any> | null} a usable record, or null when it must be dropped.
 */
export function sanitizeStoredTask(raw) {
  if (!isObject(raw) || typeof raw.id !== 'string' || !ID_SHAPE.test(raw.id)) return null;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (name === '' || name.length > MAX_NAME_LENGTH) return null;
  const trigger = sanitizeStoredTrigger(raw.trigger);
  const target = sanitizeStoredTarget(raw.target);
  if (trigger === null || target === null) return null;
  if (!isObject(raw.message) || typeof raw.message.text !== 'string' || raw.message.text.trim() === '') return null;
  if (raw.message.text.length > MAX_MESSAGE_LENGTH) return null;
  const createdAt = Number.isFinite(Date.parse(raw.createdAt)) ? new Date(Date.parse(raw.createdAt)).toISOString() : new Date(0).toISOString();
  const updatedAt = Number.isFinite(Date.parse(raw.updatedAt)) ? new Date(Date.parse(raw.updatedAt)).toISOString() : createdAt;
  const history = Array.isArray(raw.history)
    ? raw.history
      .filter((entry) => isObject(entry) && RUN_RESULTS.includes(entry.result) && typeof entry.detail === 'string' && Number.isFinite(Date.parse(entry.at)))
      .slice(0, MAX_HISTORY)
      .map((entry) => ({
        runId: typeof entry.runId === 'string' ? entry.runId : `run-${randomUUID()}`,
        at: new Date(Date.parse(entry.at)).toISOString(),
        result: entry.result,
        detail: entry.detail,
        ...(typeof entry.code === 'string' ? { code: entry.code } : {}),
        ...(isObject(entry.params) ? { params: entry.params } : {}),
        ...(typeof entry.sessionId === 'string' ? { sessionId: entry.sessionId } : {}),
      }))
    : [];
  return {
    id: raw.id,
    name,
    enabled: raw.enabled === true,
    trigger,
    target,
    message: { text: raw.message.text, goalMode: raw.message.goalMode === true },
    state: {
      status: raw.enabled === true ? 'active' : 'inactive',
      ...(Number.isFinite(Date.parse(raw.state?.nextAt)) ? { nextAt: new Date(Date.parse(raw.state.nextAt)).toISOString() } : {}),
      evaluatedThrough: Number.isFinite(Date.parse(raw.state?.evaluatedThrough))
        ? new Date(Date.parse(raw.state.evaluatedThrough)).toISOString()
        : updatedAt,
      ...(Number.isFinite(Date.parse(raw.state?.lastRunAt)) ? { lastRunAt: new Date(Date.parse(raw.state.lastRunAt)).toISOString() } : {}),
      ...(RUN_RESULTS.includes(raw.state?.lastResult) ? { lastResult: raw.state.lastResult } : {}),
      consecutiveFailures: Number.isInteger(raw.state?.consecutiveFailures) && raw.state.consecutiveFailures >= 0 ? raw.state.consecutiveFailures : 0,
      needsAttention: raw.state?.needsAttention === true,
    },
    history,
    createdAt,
    updatedAt,
  };
}

/**
 * One-line trigger description shared by the panel and the agent tool.
 * @param {Record<string, any>} trigger - Stored trigger.
 * @returns {string} a short human description.
 */
export function describeTrigger(trigger) {
  switch (trigger?.kind) {
    case 'at':
      return `once at ${trigger.at}`;
    case 'every':
      return `every ${Math.round(trigger.everySeconds / 60)} min`;
    case 'daily':
      return `daily ${trigger.time} ${trigger.timeZone}`;
    case 'weekly':
      return `weekly ${trigger.weekdays.join(',')} ${trigger.time} ${trigger.timeZone}`;
    case 'cron':
      return `cron "${trigger.expression}" ${trigger.timeZone}`;
    case 'webhook':
      return 'webhook';
    default:
      return 'unknown';
  }
}

/**
 * One-line target description shared by the panel and the agent tool.
 * @param {Record<string, any>} target - Stored target.
 * @returns {string} a short human description.
 */
export function describeTarget(target) {
  if (target?.kind === 'newSession') {
    const where = target.workspaceId ?? target.cwd ?? '?';
    return `new session in ${where}${target.agentPreset === undefined ? '' : ` (${target.agentPreset})`}`;
  }
  if (target?.kind === 'session') return `session ${target.sessionId}`;
  return 'unknown';
}

/**
 * The model-facing and API-facing projection of a record.
 * @param {Record<string, any>} task - Stored record.
 * @returns {Record<string, any>} a detached copy.
 */
export function taskView(task) {
  return {
    id: task.id,
    name: task.name,
    enabled: task.enabled,
    trigger: task.trigger,
    target: task.target,
    message: task.message,
    state: task.state,
    history: task.history,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    triggerSummary: describeTrigger(task.trigger),
    targetSummary: describeTarget(task.target),
  };
}

/**
 * Drop secrets before a record leaves the Host for the model.
 * @param {Record<string, any>} view - A {@link taskView} result.
 * @returns {Record<string, any>} the same view with the webhook secret masked.
 */
export function withoutSecret(view) {
  if (view.trigger?.kind !== 'webhook') return view;
  return { ...view, trigger: { ...view.trigger, secret: '***' } };
}
