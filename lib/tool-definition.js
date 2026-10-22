/**
 * The `task_center` tool definition.
 *
 * `defineTool` lives in `@deepseek-ai/dsh-tools`, which a profile-installed
 * plugin cannot import, so this builds the same `ToolDefinition` shape by hand:
 * a raw JSON Schema for the arguments, a raw JSON Schema for the canonical
 * result, a `render` projection and an `execute` that validates its own
 * arguments. Everything is plain data, which also makes it easy to test.
 *
 * @module @ds-hu/dsh-auto-task-center/lib/tool-definition
 */
import { describeTarget, describeTrigger, normalizeDraft, taskView, withoutSecret } from './model.js';
import { recomputeSchedule } from './scheduler.js';
import { getRuntime } from './runtime.js';

/** What the tool answers when the Host half is not mounted. */
const NOT_MOUNTED = 'Task Center is not mounted in this Host, so there are no tasks to manage. '
  + 'Ask the user to enable the @ds-hu/dsh-auto-task-center bundle, or use the official schedule tools if this '
  + 'preset still has them.';

/** One-line summary of a task for list output. */
function summarise(task) {
  return {
    id: task.id,
    name: task.name,
    enabled: task.enabled,
    status: task.state.status,
    trigger: describeTrigger(task.trigger),
    target: describeTarget(task.target),
    goalMode: task.message.goalMode === true,
    nextAt: task.state.nextAt ?? null,
    lastRunAt: task.state.lastRunAt ?? null,
    lastResult: task.state.lastResult ?? null,
    needsAttention: task.state.needsAttention === true,
  };
}

/**
 * Build the argument draft for a create call.
 * @param {Record<string, any>} args - Tool arguments.
 * @param {any} exec - Tool run context.
 * @returns {Record<string, any>} a draft for {@link normalizeDraft}.
 */
function draftFrom(args, exec) {
  const sessionId = exec?.agent?.session?.id;
  return {
    name: args.name,
    enabled: args.enabled,
    trigger: args.trigger,
    target: args.target ?? (sessionId === undefined ? undefined : { kind: 'session', sessionId }),
    message: args.message,
  };
}

/**
 * Validate the arguments this tool accepts.
 *
 * The registry only declares the schema; nothing enforces it for a hand-built
 * definition, so the shape is checked here before any work happens.
 *
 * @param {unknown} args - Raw arguments.
 * @returns {Record<string, any>} the arguments, narrowed.
 * @throws {Error} when the arguments are not an object with a known action.
 */
function assertArguments(args) {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new Error('task_center expects an object with an "action"');
  }
  const action = args.action;
  if (!['create', 'list', 'update', 'delete'].includes(action)) {
    throw new Error('task_center "action" must be one of create, list, update, delete');
  }
  if ((action === 'update' || action === 'delete') && (typeof args.id !== 'string' || args.id === '')) {
    throw new Error(`task_center "${action}" needs the task id`);
  }
  return args;
}

/** The hand-built tool definition. */
export const TASK_CENTER_TOOL = {
  name: 'task_center',
  description: [
    'Manage Host-wide Task Center tasks: scheduled and webhook jobs that later deliver a message into a session.',
    'Unlike the session-scoped reminder tools, these tasks belong to the whole Host and can target any workspace.',
    'A task fires once (`at`), on an interval (`every`), at a wall-clock time (`daily`, `weekly`), on a cron',
    'expression, or when someone POSTs to its webhook URL. Every task has exactly one trigger.',
    'The delivered body is sent as an ordinary user message, so `/skill-name` gestures in it still load skills;',
    'set `message.goalMode` to run the body as `/goal <body>` instead.',
    'Targets: `{kind:"newSession", workspaceId}` or `{kind:"newSession", cwd}` opens a fresh session (optionally with',
    '`agentPreset`, default standard) in that workspace; `{kind:"session", sessionId}` writes into an existing one.',
    'Omit `target` on create to deliver into the calling session.',
    'Actions: `list` (everything, with next run and last result), `create`, `update` (send the full task plus `id`),',
    '`delete`. Times use `HH:mm` or `HH:mm:ss`; zones use IANA names such as Asia/Shanghai; cron accepts five fields',
    'without names or macros. `{{payload}}` in the body is replaced by a webhook request body.',
  ].join(' '),
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'list', 'update', 'delete'],
        description: 'What to do.',
      },
      id: {
        type: 'string',
        description: 'Task id. Required for update and delete; ignored otherwise.',
      },
      name: {
        type: 'string',
        description: 'Short task name shown in the panel, at most 120 characters.',
      },
      enabled: {
        type: 'boolean',
        description: 'Whether the task runs. Defaults to true on create; omitted on update keeps the draft value.',
      },
      trigger: {
        type: 'object',
        description: 'When the task fires. Exactly one shape, selected by "kind": '
          + '{kind:"at", at:"<ISO 8601 instant>"} once, in the future; '
          + '{kind:"every", everySeconds:<integer >= 60>} on a fixed interval; '
          + '{kind:"daily", time:"09:00", timeZone:"Asia/Shanghai"}; '
          + '{kind:"weekly", time:"09:00", timeZone:"Asia/Shanghai", weekdays:[1,3,5]} with ISO days 1=Monday..7=Sunday; '
          + '{kind:"cron", expression:"0 9 * * 1-5", timeZone:"Asia/Shanghai"} five fields; '
          + '{kind:"webhook"} waits for an HTTP request instead of the clock.',
        properties: {
          kind: { type: 'string', enum: ['at', 'every', 'daily', 'weekly', 'cron', 'webhook'] },
          at: { type: 'string', description: 'ISO 8601 instant, used by kind "at".' },
          everySeconds: { type: 'integer', minimum: 60, description: 'Fixed interval in seconds, used by kind "every".' },
          time: { type: 'string', description: 'Local time HH:mm or HH:mm:ss, used by daily and weekly.' },
          timeZone: { type: 'string', description: 'IANA zone such as Asia/Shanghai, used by daily, weekly and cron.' },
          weekdays: {
            type: 'array',
            items: { type: 'integer', minimum: 1, maximum: 7 },
            description: 'ISO weekdays, used by kind "weekly".',
          },
          expression: { type: 'string', description: 'Five-field cron expression, used by kind "cron".' },
        },
        required: ['kind'],
        additionalProperties: false,
      },
      target: {
        type: 'object',
        description: 'Where the message goes. {kind:"newSession", workspaceId} or {kind:"newSession", cwd, agentPreset?} '
          + 'opens a session in that workspace; {kind:"session", sessionId} writes into an existing session.',
        properties: {
          kind: { type: 'string', enum: ['newSession', 'session'] },
          workspaceId: { type: 'string', description: 'Workspace id for a new session.' },
          cwd: { type: 'string', description: 'Absolute directory for a new session, when no workspace id is given.' },
          agentPreset: { type: 'string', description: 'Agent preset for the new session, for example standard or task-center.' },
          sessionId: { type: 'string', description: 'Existing session id.' },
        },
        required: ['kind'],
        additionalProperties: false,
      },
      message: {
        type: 'object',
        description: 'What to deliver.',
        properties: {
          text: {
            type: 'string',
            description: 'The body, at most 16 KiB. Sent verbatim as a user message; `{{payload}}` is replaced by a '
              + 'webhook request body (an empty string for timed runs).',
          },
          goalMode: {
            type: 'boolean',
            description: 'When true the body runs as `/goal <text>` instead of being sent as a message.',
          },
        },
        required: ['text'],
        additionalProperties: false,
      },
    },
    required: ['action'],
    additionalProperties: false,
  },
  output: {
    schema: { type: 'object', additionalProperties: true },
    /**
     * Project the canonical value into model-facing text.
     * @param {unknown} _args - Validated arguments (unused).
     * @param {unknown} value - Canonical result.
     * @returns {{ type: 'text', text: string }[]} one text block of pretty JSON.
     */
    render(_args, value) {
      return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
    },
  },
  /**
   * Run one call.
   * @param {unknown} rawArgs - Model arguments.
   * @param {any} exec - Tool run context.
   * @returns {Promise<Record<string, unknown>>} the canonical result.
   */
  async execute(rawArgs, exec) {
    const args = assertArguments(rawArgs);
    const runtime = getRuntime();
    if (runtime === undefined) return { ok: false, code: 'not-mounted', error: NOT_MOUNTED };
    const { store, now } = runtime;
    try {
      switch (args.action) {
        case 'list': {
          const tasks = store.list()
            .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
            .map(summarise);
          return { ok: true, count: tasks.length, tasks };
        }
        case 'create': {
          const task = normalizeDraft(draftFrom(args, exec), { nowMs: now() });
          recomputeSchedule(task, now());
          await store.put(task);
          return { ok: true, task: withoutSecret(taskView(task)), created: task.id };
        }
        case 'update': {
          const existing = store.get(args.id);
          if (existing === undefined) return { ok: false, code: 'not-found', error: `no task ${args.id}` };
          const task = normalizeDraft({
            name: args.name ?? existing.name,
            enabled: args.enabled ?? existing.enabled,
            trigger: args.trigger ?? existing.trigger,
            target: args.target ?? existing.target,
            message: args.message ?? existing.message,
          }, { nowMs: now(), existing });
          recomputeSchedule(task, now());
          await store.put(task);
          return { ok: true, task: withoutSecret(taskView(task)), updated: task.id };
        }
        case 'delete': {
          const removed = await store.remove(args.id);
          if (!removed) return { ok: false, code: 'not-found', error: `no task ${args.id}` };
          return { ok: true, deleted: args.id };
        }
        default:
          return { ok: false, code: 'bad-action', error: `unknown action ${String(args.action)}` };
      }
    } catch (error) {
      if (error?.name === 'TaskInputError') {
        return { ok: false, code: error.code, error: error.message };
      }
      return { ok: false, code: 'failed', error: error?.message ?? String(error) };
    }
  },
};
