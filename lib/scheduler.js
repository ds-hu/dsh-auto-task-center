/**
 * The scheduler: one timer, one pass, and the bookkeeping that survives a
 * restart.
 *
 * The Host arms a single `setTimeout` for the earliest `nextAt` in the store
 * and re-arms after every pass — the same shape the official DSH scheduler
 * uses, so a thousand tasks still cost one timer. A pass delivers everything
 * that is due, then recomputes every schedule and persists only what changed.
 *
 * Downtime is handled explicitly: an occurrence that came due while the Host
 * was not running is never delivered late. It becomes one `missed` run record
 * naming the count and the last skipped instant, which is what
 * `evaluatedThrough` exists to make exact.
 *
 * @module @ds-hu/dsh-auto-task-center/lib/scheduler
 */
import { appendHistory } from './model.js';
import { countOccurrences, nextOccurrence } from './engine.js';
import { createEvent, describeEvent, waitsForEvent } from './events.js';

/** Largest delay `setTimeout` accepts without overflowing. */
const MAX_TIMEOUT_MS = 2_147_483_647;
/** How long one delivery may take before it is abandoned. */
const DEFAULT_RUN_TIMEOUT_MS = 120_000;

/**
 * Recompute a task's status and next occurrence from a clock reading.
 *
 * An event-driven trigger (a webhook address or a manual task) has no next
 * occurrence but is still "active" while enabled: it waits for a request or a
 * person rather than for the clock.
 *
 * @param {Record<string, any>} task - Record to update in place.
 * @param {number} nowMs - Clock reading to schedule from.
 * @returns {boolean} whether anything changed.
 */
export function recomputeSchedule(task, nowMs) {
  const before = `${task.state.status}|${task.state.nextAt ?? ''}`;
  task.state.evaluatedThrough = new Date(nowMs).toISOString();
  if (!task.enabled) {
    task.state.status = 'inactive';
    delete task.state.nextAt;
  } else if (waitsForEvent(task.trigger.kind)) {
    task.state.status = 'active';
    delete task.state.nextAt;
  } else {
    const next = nextOccurrence(task.trigger, nowMs);
    if (next === undefined) {
      task.state.status = 'inactive';
      delete task.state.nextAt;
    } else {
      task.state.status = 'active';
      task.state.nextAt = new Date(next).toISOString();
    }
  }
  return before !== `${task.state.status}|${task.state.nextAt ?? ''}`;
}

/**
 * Build the scheduler.
 *
 * @param {object} options - Scheduler options.
 * @param {ReturnType<typeof import('./store.js').createStore>} options.store - The task store.
 * @param {{ deliver: (input: { task: Record<string, any>, payload?: string, signal: AbortSignal }) => Promise<{ sessionId: string, worktree?: { path: string, branch: string }, applied?: { model?: string, permission?: string } }> }} options.deliverer - The deliverer.
 * @param {() => number} [options.now] - Clock, injectable for tests.
 * @param {(level: string, message: string) => void} [options.logger] - Diagnostic sink.
 * @param {number} [options.runTimeoutMs] - Delivery budget.
 * @returns {object} the scheduler handle.
 */
export function createScheduler({ store, deliverer, now = () => Date.now(), logger = () => {}, runTimeoutMs = DEFAULT_RUN_TIMEOUT_MS }) {
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  /** @type {Promise<void> | null} */
  let inFlight = null;
  let stopped = false;
  let busy = false;
  /** @type {(() => void) | undefined} */
  let unsubscribe;

  /**
   * Fire one task for one event: deliver, record the outcome, advance the schedule.
   *
   * Every source funnels through here, so a scheduled run, an HTTP request and
   * a manual run differ only in the event they carry — never in how delivery,
   * failure counting or the record itself behaves.
   *
   * The run record is written even when delivery fails, and a failure never
   * stops the task: it stays enabled and is only marked as needing attention.
   *
   * @param {Record<string, any>} task - Detached record.
   * @param {{ source: string, at: string, payload?: string, actor?: string }} event - What caused the run.
   * @returns {Promise<Record<string, any>>} the appended run record.
   */
  async function fire(task, event) {
    const startedAt = new Date(now()).toISOString();
    let entry;
    try {
      const signal = AbortSignal.timeout(runTimeoutMs);
      const { sessionId, worktree, applied } = await deliverer.deliver({ task, payload: event.payload, signal });
      task.state.consecutiveFailures = 0;
      task.state.needsAttention = false;
      // The worktree, model and permission are run parameters, not task state:
      // a worktree is made per run, and the record is the only place that has
      // to remember what a run actually used.
      const details = `delivered to session ${sessionId}`
        + (worktree === undefined ? '' : ` in worktree ${worktree.branch} (${worktree.path})`)
        + (applied?.model === undefined ? '' : ` using ${applied.model}`)
        + (applied?.permission === undefined ? '' : ` as ${applied.permission}`);
      entry = appendHistory(task, {
        at: startedAt,
        result: 'ok',
        source: event.source,
        code: 'delivered',
        params: {
          sessionId,
          ...(worktree === undefined ? {} : { worktree }),
          ...(applied?.model === undefined ? {} : { model: applied.model }),
          ...(applied?.permission === undefined ? {} : { permission: applied.permission }),
        },
        detail: details,
        sessionId,
      }).history[0];
    } catch (error) {
      const message = error?.message ?? String(error);
      const code = typeof error?.code === 'string' ? error.code : 'unknown';
      task.state.consecutiveFailures = (Number(task.state.consecutiveFailures) || 0) + 1;
      task.state.needsAttention = true;
      entry = appendHistory(task, {
        at: startedAt,
        result: 'failed',
        source: event.source,
        code: 'failed',
        params: { message },
        detail: `${code}: ${message}`,
      }).history[0];
      logger('warn', `task-center: task ${task.id} (${task.name}) failed on a ${describeEvent(event)}: ${message}`);
    }
    recomputeSchedule(task, now());
    await store.put(task);
    return entry;
  }

  /**
   * Deliver everything that is due, then realign every schedule.
   * @returns {Promise<void>} resolves when the pass settles.
   */
  async function tick() {
    if (stopped) return;
    if (busy) return;
    busy = true;
    try {
      const nowMs = now();
      const due = store.list().filter((task) => {
        if (!task.enabled) return false;
        if (task.state.nextAt === undefined) return false;
        return Date.parse(task.state.nextAt) <= nowMs;
      });
      for (const task of due) {
        if (stopped) return;
        logger('info', `task-center: firing ${task.name} (${task.id}) on its schedule`);
        await fire(task, createEvent({ source: 'schedule', at: nowMs }));
      }
      const resetAt = now();
      for (const task of store.list()) {
        if (recomputeSchedule(task, resetAt)) await store.put(task);
      }
    } catch (error) {
      logger('error', `task-center: a scheduler pass failed: ${error?.message ?? error}`);
    } finally {
      busy = false;
      arm();
    }
  }

  /** Re-arm the single timer for the earliest pending occurrence. */
  function arm() {
    if (stopped) return;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    let earliest;
    for (const task of store.list()) {
      if (!task.enabled || task.state.nextAt === undefined) continue;
      const at = Date.parse(task.state.nextAt);
      if (!Number.isFinite(at)) continue;
      if (earliest === undefined || at < earliest) earliest = at;
    }
    if (earliest === undefined) return;
    const delay = Math.max(0, Math.min(earliest - now(), MAX_TIMEOUT_MS));
    timer = setTimeout(() => {
      timer = null;
      inFlight = tick().finally(() => {
        inFlight = null;
      });
    }, delay);
    // A pending occurrence must never keep the process alive on its own.
    if (typeof timer.unref === 'function') timer.unref();
  }

  /** Normalize schedules after a restart, recording anything that was skipped. */
  async function catchUp() {
    const nowMs = now();
    for (const task of store.list()) {
      if (task.enabled && !waitsForEvent(task.trigger.kind)) {
        const through = Number.isFinite(Date.parse(task.state.evaluatedThrough))
          ? Date.parse(task.state.evaluatedThrough)
          : Date.parse(task.updatedAt);
        const { count, last } = countOccurrences(task.trigger, through, nowMs);
        if (count > 0 && last !== undefined) {
          const lastIso = new Date(last).toISOString();
          appendHistory(task, {
            at: new Date(nowMs).toISOString(),
            result: 'missed',
            code: 'skipped',
            params: { count, last: lastIso },
            detail: `skipped ${count} occurrence(s) while the Host was not running; the last was due at ${lastIso}`,
          });
          logger('info', `task-center: task ${task.name} skipped ${count} occurrence(s) while the Host was not running`);
        }
      }
      recomputeSchedule(task, nowMs);
      await store.put(task);
    }
  }

  return {
    /**
     * Catch up from disk and start the timer.
     * @returns {Promise<void>} resolves once the first arm completed.
     */
    async start() {
      stopped = false;
      await catchUp();
      unsubscribe = store.onChange(() => {
        if (!busy) arm();
      });
      arm();
    },
    /**
     * Stop the timer and wait for an in-flight pass.
     * @returns {Promise<void>} resolves when nothing is running.
     */
    async stop() {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      unsubscribe?.();
      unsubscribe = undefined;
      await (inFlight ?? Promise.resolve());
    },
    /**
     * Dispatch one event at one task: an HTTP request, a manual run, or an
     * explicit schedule nudge from a test.
     * @param {string} taskId - Task identity.
     * @param {{ source: string, at: string, payload?: string, actor?: string }} event - What caused the run.
     * @returns {Promise<Record<string, any> | undefined>} the run record, or undefined when the task is gone.
     */
    async dispatch(taskId, event) {
      const task = store.get(taskId);
      if (task === undefined) return undefined;
      return fire(task, event);
    },
    /** Re-arm the timer, e.g. after an API mutation changed `nextAt`. */
    reschedule: arm,
    /** Run one pass immediately, for tests and for a manual nudge. */
    tick,
  };
}
