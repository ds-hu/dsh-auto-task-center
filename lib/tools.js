/**
 * The 任务管理 preset's half: register `task_center` in the agent scope.
 *
 * A preset names this module (`@ds-hu/dsh-auto-task-center/tools`) instead of
 * the package root, so mounting the preset adds the tool without mounting a
 * second copy of the panel, the store and the scheduler. The tool asks
 * `lib/runtime.js` for the plugin the profile root already mounted.
 *
 * @module @ds-hu/dsh-auto-task-center/lib/tools
 */
import { TASK_CENTER_TOOL } from './tool-definition.js';

/** Plugin name registered with the Loader. */
export const name = 'task-center-tools';

/** Agent-scoped tool registry; a preset that omits `tools` stays inert. */
export const inject = ['tools'];

/**
 * Register the single `task_center` tool in the mounting scope.
 * @param {any} ctx - Host plugin context (Cordis).
 * @returns {void}
 */
export function apply(ctx) {
  ctx.effect(() => ctx.tools.register(TASK_CENTER_TOOL), 'task-center: task_center tool');
}
