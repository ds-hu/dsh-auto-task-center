/**
 * The one mutable slot shared by the two halves of the Host side.
 *
 * `lib/index.js` mounts at the profile root and owns the store, the scheduler
 * and the HTTP routes. `lib/tools.js` is mounted *inside an agent preset* and
 * only registers a tool. A third-party plugin cannot publish a Cordis service
 * without importing `@deepseek-ai/cordis`, so the preset half reaches the
 * running plugin through this module instead: both specifiers resolve to files
 * in the same directory, so Node's module cache hands them the same instance.
 *
 * When the Host half is not mounted the slot stays empty and the tool answers
 * with a structured error rather than throwing.
 *
 * @module @ds-hu/dsh-auto-task-center/lib/runtime
 */

/** @type {{ store: any, scheduler: any, ctx: any, now: () => number } | undefined} */
let current;

/**
 * Publish the running plugin, or clear it on dispose.
 * @param {{ store: any, scheduler: any, ctx: any, now: () => number } | undefined} runtime - The runtime, or undefined.
 * @returns {void}
 */
export function setRuntime(runtime) {
  current = runtime;
}

/**
 * The running plugin, when the Host half is mounted.
 * @returns {{ store: any, scheduler: any, ctx: any, now: () => number } | undefined} the runtime.
 */
export function getRuntime() {
  return current;
}
