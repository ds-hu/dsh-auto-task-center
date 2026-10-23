/**
 * The panel API and the webhook route.
 *
 * Both live under one prefix registration on the Host web server:
 * `/task-center/api/*` for the panel, `/task-center/hook/<id>/<secret>` for
 * outside callers. Every mutation answers with the affected record so the
 * panel can keep one source of truth without a second round trip.
 *
 * @module @ds-hu/dsh-auto-task-center/lib/api
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  MAX_HOOK_BYTES,
  HttpError,
  assertSameOriginJson,
  readBody,
  readJson,
  sendError,
  sendJson,
} from './http.js';
import { TaskInputError, newSecret, normalizeDraft, taskView } from './model.js';
import { previewOccurrences } from './engine.js';
import { recomputeSchedule } from './scheduler.js';

/** Panel API prefix. */
const API_PREFIX = '/task-center/api';
/** Webhook requests allowed per task per minute. */
const HOOK_LIMIT_PER_MINUTE = 60;
/** One webhook call: task id and secret, both in the path. */
const HOOK_ROUTE = /^\/task-center\/hook\/([^/]+)\/([^/]+)\/?$/u;
/** How long a webhook request waits for its delivery before answering 202. */
const HOOK_AWAIT_MS = 30_000;

/**
 * Compare two secrets without leaking their length or content through timing.
 * @param {string} given - Secret from the request path.
 * @param {string} expected - Stored secret.
 * @returns {boolean} whether they match.
 */
function secretMatches(given, expected) {
  const a = createHash('sha256').update(given, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/**
 * Build the HTTP surface of the plugin.
 *
 * @param {object} options - API options.
 * @param {ReturnType<typeof import('./store.js').createStore>} options.store - The task store.
 * @param {ReturnType<typeof import('./scheduler.js').createScheduler>} options.scheduler - The scheduler.
 * @param {any} options.ctx - Host plugin context.
 * @param {ReturnType<typeof import('./worktree.js').createWorktreeClient>} [options.worktrees] - The optional worktree integration.
 * @param {() => string} options.origin - Getter for the Host origin, for the URLs the panel shows and the same-origin guard.
 * @param {string} options.version - Plugin version.
 * @param {() => number} [options.now] - Clock, injectable for tests.
 * @param {(level: string, message: string) => void} [options.logger] - Diagnostic sink.
 * @returns {{ handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void> }} the router.
 */
export function createApi({ store, scheduler, ctx, worktrees, origin: originOf, version, now = () => Date.now(), logger = () => {} }) {
  /** @type {Map<string, number[]>} */
  const hookHits = new Map();

  /**
   * Refuse a task that produced too many webhook requests in the last minute.
   * @param {string} taskId - Task identity.
   * @returns {boolean} whether the request may proceed.
   */
  function allowHook(taskId) {
    const cutoff = now() - 60_000;
    const hits = (hookHits.get(taskId) ?? []).filter((at) => at > cutoff);
    if (hits.length >= HOOK_LIMIT_PER_MINUTE) {
      hookHits.set(taskId, hits);
      return false;
    }
    hits.push(now());
    hookHits.set(taskId, hits);
    return true;
  }

  /** How long a model catalog is reused; provider lookups reach the network. */
  const MODEL_CACHE_MS = 60_000;
  /** @type {{ at: number, value: Record<string, unknown> } | undefined} */
  let modelCache;

  /**
   * The models this deployment can route, flattened for one select.
   *
   * `modelCatalog` asks every provider adapter, which can hit the network, so
   * the answer is cached and the panel only reads it when the session is new.
   * A deployment with no catalog simply offers the default.
   *
   * @returns {Promise<{ options: Record<string, unknown>[], default: Record<string, string> | null }>} the catalog view.
   */
  async function modelCatalogView() {
    const at = now();
    if (modelCache !== undefined && at - modelCache.at < MODEL_CACHE_MS) return modelCache.value;
    /** @type {Record<string, unknown>[]} */
    let options = [];
    /** @type {Record<string, string> | null} */
    let fallback = null;
    try {
      const catalog = await ctx.sessionController.modelCatalog?.();
      if (catalog !== undefined) {
        for (const group of catalog.groups ?? []) {
          for (const model of group.models ?? []) {
            options.push({
              provider: group.id,
              providerName: group.name ?? group.id,
              model: model.id,
              name: model.name ?? model.id,
              ...(model.reasoning === undefined ? {} : { efforts: (model.reasoning.efforts ?? []).map((effort) => effort.id) }),
            });
          }
        }
        fallback = { provider: catalog.default?.provider ?? '', model: catalog.default?.model ?? '' };
        if (options.length > 200) options = options.slice(0, 200);
      }
    } catch (error) {
      logger('warn', `task-center: cannot read the model catalog: ${error?.message ?? error}`);
    }
    const value = { options, default: fallback };
    modelCache = { at, value };
    return value;
  }

  /**
   * The permission presets this profile offers, in contribution order.
   *
   * The names are the Host's own keys; the panel localises the three it knows
   * and shows anything else verbatim, so a custom preset still works.
   *
   * @returns {{ options: Record<string, unknown>[], default: string | null }} the preset view.
   */
  function permissionCatalogView() {
    try {
      const catalog = ctx.get?.('permissionPresets')?.catalog?.();
      if (catalog === undefined) return { options: [], default: null };
      return {
        options: (catalog.options ?? []).map((option) => ({
          value: option.value,
          name: option.name ?? option.value,
          ...(option.description === undefined ? {} : { description: option.description }),
        })),
        default: typeof catalog.defaultPreset === 'string' ? catalog.defaultPreset : null,
      };
    } catch (error) {
      logger('warn', `task-center: cannot read the permission catalog: ${error?.message ?? error}`);
      return { options: [], default: null };
    }
  }

  /**
   * Everything the panel needs in one response.
   * @returns {Promise<Record<string, unknown>>} the panel state.
   */
  async function panelState() {
    /** @type {Record<string, unknown>[]} */
    let workspaces = [];
    try {
      workspaces = (ctx.get?.('workspaceRegistry')?.list?.() ?? []).map((workspace) => ({
        id: workspace.id,
        title: workspace.title,
        path: workspace.path,
      }));
    } catch (error) {
      logger('warn', `task-center: cannot list workspaces: ${error?.message ?? error}`);
    }
    /** @type {Record<string, unknown>[]} */
    let presets = [];
    let presetsAvailable = false;
    try {
      const registry = ctx.get?.('agentPresets');
      if (registry !== undefined) {
        const listed = await registry.list();
        presets = listed
          .filter((preset) => preset.broken === undefined)
          .map((preset) => ({ id: preset.id, name: preset.name ?? preset.id, description: preset.description ?? '' }))
          .sort((a, b) => a.id.localeCompare(b.id));
        presetsAvailable = true;
      }
    } catch (error) {
      logger('warn', `task-center: cannot list agent presets: ${error?.message ?? error}`);
    }
    const tasks = store.list()
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
      .map(taskView);
    const models = await modelCatalogView();
    const permissions = permissionCatalogView();
    return {
      ok: true,
      serverTime: new Date(now()).toISOString(),
      origin: originOf(),
      version,
      tasks,
      workspaces,
      presets,
      models,
      permissions,
      capabilities: {
        workspaces: workspaces.length > 0,
        presets: presetsAvailable,
        commands: ctx.get?.('commands') !== undefined,
        sessions: ctx.sessionController !== undefined,
        // Fresh worktrees come from another plugin; the panel only offers the
        // option when that plugin answers on this Host.
        worktrees: worktrees === undefined ? false : (await worktrees.probe()).present,
        models: models.options.length > 0,
        permissions: permissions.options.length > 0,
      },
    };
  }

  /**
   * Base branches for one workspace, when it can host a fresh worktree.
   *
   * The other plugin owns the answer — which branches exist, which one is the
   * default, whether the directory is a git root at all — so this route is a
   * thin proxy that keeps the panel talking to one origin.
   *
   * @param {URL} url - Request URL carrying `workspaceId`.
   * @returns {Promise<Record<string, unknown>>} the branch choices.
   */
  async function worktreeOptions(url) {
    if (worktrees === undefined) {
      throw new HttpError(501, 'worktrees-unavailable', 'this profile composes no worktree integration');
    }
    const workspaceId = url.searchParams.get('workspaceId') ?? '';
    if (workspaceId === '') throw new HttpError(400, 'workspace-required', 'workspaceId is required');
    const rows = ctx.get?.('workspaceRegistry')?.list?.() ?? [];
    const hit = Array.isArray(rows) ? rows.find((row) => (row?.workspaceId ?? row?.id) === workspaceId) : undefined;
    const repoPath = hit?.path;
    if (typeof repoPath !== 'string' || repoPath === '') {
      throw new HttpError(404, 'workspace-missing', `no workspace ${workspaceId}`);
    }
    try {
      const options = await worktrees.options({ repoPath });
      if (options.isGit !== true) {
        throw new HttpError(409, 'worktree-not-git-root', 'this workspace is not a git repository, so a worktree cannot be created in it');
      }
      return { ok: true, defaultBranch: options.defaultBranch ?? null, branches: options.branches ?? [] };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (error?.name === 'WorktreeError') throw new HttpError(503, error.code, error.message);
      throw error;
    }
  }

  /** How long one Host session listing is reused before asking again. */
  const SESSION_CACHE_MS = 15_000;
  /** Last successful Host listing, or undefined before the first. */
  let sessionCache;

  /**
   * The Host session list, reused briefly.
   *
   * `sessionController.list` summarizes every session directory and takes a
   * couple of seconds on a large profile, while the picker only needs a list
   * that is fresh to within a minute. A short cache keeps reopening the panel
   * cheap without hiding a session created moments ago.
   *
   * @returns {Promise<{ items: readonly any[] }>} the listing.
   */
  async function sessionCatalog() {
    const at = now();
    if (sessionCache !== undefined && at - sessionCache.at < SESSION_CACHE_MS) return sessionCache.value;
    const value = await ctx.sessionController.list({}, AbortSignal.timeout(60_000));
    sessionCache = { at: now(), value };
    return value;
  }

  /**
   * Session rows for the target picker.
   *
   * Rows carry what the Host list projection offers cheaply — identity,
   * directory and recency. A human title would need one projection read per
   * session, so the panel enriches from its own session catalog when it can
   * and otherwise shows the directory.
   *
   * @param {URL} url - Request URL, for `q` and `limit`.
   * @returns {Promise<Record<string, unknown>>} the rows.
   */
  async function sessionRows(url) {
    if (ctx.sessionController === undefined) {
      throw new HttpError(501, 'sessions-unavailable', 'this profile composes no session service');
    }
    const query = (url.searchParams.get('q') ?? '').toLowerCase();
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 50) || 50, 1), 200);
    const rows = (await sessionCatalog()).items
      .filter((item) => item.origin !== 'subagent')
      .filter((item) => query === ''
        || String(item.sessionId).toLowerCase().includes(query)
        || String(item.cwd ?? '').toLowerCase().includes(query))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit)
      .map((item) => ({
        sessionId: item.sessionId,
        cwd: item.cwd ?? null,
        updatedAt: new Date(item.updatedAt).toISOString(),
        running: item.running === true,
        blank: item.blank === true,
      }));
    return { ok: true, items: rows };
  }

  /**
   * Create a task from a draft.
   * @param {import('node:http').IncomingMessage} req - Request.
   * @param {import('node:http').ServerResponse} res - Response.
   * @returns {Promise<void>} resolves after the response.
   */
  async function createTask(req, res) {
    assertSameOriginJson(req, originOf());
    const draft = await readJson(req);
    const task = normalizeDraft(draft, { nowMs: now() });
    recomputeSchedule(task, now());
    await store.put(task);
    sendJson(res, 200, { ok: true, task: taskView(task) });
  }

  /**
   * Replace one task from a draft.
   * @param {import('node:http').IncomingMessage} req - Request.
   * @param {import('node:http').ServerResponse} res - Response.
   * @param {string} id - Task identity.
   * @returns {Promise<void>} resolves after the response.
   */
  async function updateTask(req, res, id) {
    assertSameOriginJson(req, originOf());
    const existing = store.get(id);
    if (existing === undefined) throw new HttpError(404, 'not-found', `no task ${id}`);
    const body = await readJson(req);
    if (typeof body.expectedUpdatedAt === 'string' && body.expectedUpdatedAt !== existing.updatedAt) {
      throw new HttpError(409, 'conflict', 'this task changed since the panel loaded it; reload and try again');
    }
    const task = normalizeDraft(body.task ?? body, { nowMs: now(), existing });
    recomputeSchedule(task, now());
    await store.put(task);
    sendJson(res, 200, { ok: true, task: taskView(task) });
  }

  /**
   * Dispatch one panel API request.
   * @param {import('node:http').IncomingMessage} req - Request.
   * @param {import('node:http').ServerResponse} res - Response.
   * @param {URL} url - Parsed URL.
   * @returns {Promise<void>} resolves after the response.
   */
  async function routeApi(req, res, url) {
    const method = req.method ?? 'GET';
    const path = url.pathname.replace(/\/+$/u, '');
    const relative = path.slice(API_PREFIX.length);
    if (relative === '/state') {
      if (method !== 'GET') throw new HttpError(405, 'method-not-allowed', 'use GET');
      sendJson(res, 200, await panelState());
      return;
    }
    if (relative === '/sessions') {
      if (method !== 'GET') throw new HttpError(405, 'method-not-allowed', 'use GET');
      sendJson(res, 200, await sessionRows(url));
      return;
    }
    if (relative === '/worktree-options') {
      if (method !== 'GET') throw new HttpError(405, 'method-not-allowed', 'use GET');
      sendJson(res, 200, await worktreeOptions(url));
      return;
    }
    if (relative === '/preview') {
      if (method !== 'POST') throw new HttpError(405, 'method-not-allowed', 'use POST');
      assertSameOriginJson(req, originOf());
      const body = await readJson(req);
      const probe = normalizeDraft({
        name: 'preview',
        trigger: body.trigger,
        target: { kind: 'session', sessionId: 'preview' },
        message: { text: 'preview' },
      }, { nowMs: now() });
      sendJson(res, 200, { ok: true, next: previewOccurrences(probe.trigger, now()) });
      return;
    }
    if (relative === '/tasks') {
      if (method !== 'POST') throw new HttpError(405, 'method-not-allowed', 'use POST');
      await createTask(req, res);
      return;
    }
    const taskRoute = /^\/tasks\/([^/]+)(?:\/(delete|rotate-secret|clear-history))?$/u.exec(relative);
    if (taskRoute !== null) {
      const id = decodeURIComponent(taskRoute[1]);
      const action = taskRoute[2];
      if (action === undefined) {
        if (method !== 'POST') throw new HttpError(405, 'method-not-allowed', 'use POST');
        await updateTask(req, res, id);
        return;
      }
      if (method !== 'POST') throw new HttpError(405, 'method-not-allowed', 'use POST');
      assertSameOriginJson(req, originOf());
      const existing = store.get(id);
      if (existing === undefined) throw new HttpError(404, 'not-found', `no task ${id}`);
      if (action === 'delete') {
        await store.remove(id);
        scheduler.reschedule();
        sendJson(res, 200, { ok: true, deleted: id });
        return;
      }
      if (action === 'rotate-secret') {
        if (existing.trigger.kind !== 'webhook') {
          throw new HttpError(400, 'not-a-webhook', 'only webhook tasks carry a secret');
        }
        existing.trigger = { ...existing.trigger, secret: newSecret() };
        existing.updatedAt = new Date(now()).toISOString();
        await store.put(existing);
        sendJson(res, 200, { ok: true, task: taskView(existing) });
        return;
      }
      existing.history = [];
      existing.updatedAt = new Date(now()).toISOString();
      await store.put(existing);
      sendJson(res, 200, { ok: true, task: taskView(existing) });
      return;
    }
    throw new HttpError(404, 'not-found', `no route for ${path}`);
  }

  /**
   * Handle one webhook call.
   * @param {import('node:http').IncomingMessage} req - Request.
   * @param {import('node:http').ServerResponse} res - Response.
   * @param {string} taskId - Task identity from the path.
   * @param {string} secret - Secret from the path.
   * @returns {Promise<void>} resolves after the response.
   */
  async function routeHook(req, res, taskId, secret) {
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'POST') {
      throw new HttpError(405, 'method-not-allowed', 'use GET or POST');
    }
    const task = store.get(taskId);
    if (task === undefined || task.trigger.kind !== 'webhook') {
      throw new HttpError(404, 'not-found', 'no such webhook task');
    }
    if (!secretMatches(secret, task.trigger.secret)) {
      throw new HttpError(403, 'forbidden', 'the webhook secret does not match');
    }
    if (!task.enabled) throw new HttpError(409, 'disabled', 'this task is disabled');
    if (!allowHook(taskId)) {
      throw new HttpError(429, 'too-many-requests', `at most ${HOOK_LIMIT_PER_MINUTE} webhook calls per minute`);
    }
    const payload = method === 'POST' ? await readBody(req, MAX_HOOK_BYTES) : '';
    const run = scheduler.runNow(taskId, { payload });
    run.catch((error) => logger('warn', `task-center: webhook delivery for ${taskId} failed late: ${error?.message ?? error}`));
    const timeout = new Promise((resolve) => {
      const handle = setTimeout(() => resolve('timeout'), HOOK_AWAIT_MS);
      if (typeof handle.unref === 'function') handle.unref();
    });
    const settled = await Promise.race([run, timeout]);
    if (settled === 'timeout') {
      sendJson(res, 202, { ok: true, pending: true });
      return;
    }
    const entry = settled;
    if (entry === undefined) throw new HttpError(404, 'not-found', 'the task disappeared before it could run');
    const ok = entry.result === 'ok';
    sendJson(res, ok ? 200 : 500, {
      ok,
      runId: entry.runId,
      result: entry.result,
      ...(entry.sessionId === undefined ? {} : { sessionId: entry.sessionId }),
      ...(ok ? {} : { error: entry.detail }),
    });
  }

  /**
   * The single registered route handler.
   * @param {import('node:http').IncomingMessage} req - Request.
   * @param {import('node:http').ServerResponse} res - Response.
   * @returns {Promise<void>} resolves after the response.
   */
  async function handler(req, res) {
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://task-center.invalid');
    } catch {
      sendError(res, 400, 'bad-request', 'malformed request URL');
      return;
    }
    try {
      if (url.pathname.startsWith(`${API_PREFIX}/`) || url.pathname === API_PREFIX) {
        await routeApi(req, res, url);
        return;
      }
      const hook = HOOK_ROUTE.exec(url.pathname);
      if (hook !== null) {
        await routeHook(req, res, decodeURIComponent(hook[1]), decodeURIComponent(hook[2]));
        return;
      }
      throw new HttpError(404, 'not-found', `no route for ${url.pathname}`);
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (error instanceof HttpError) {
        sendError(res, error.status, error.code, error.message);
        return;
      }
      if (error instanceof TaskInputError) {
        sendError(res, 400, error.code, error.message);
        return;
      }
      logger('warn', `task-center: ${req.method} ${url.pathname} failed: ${error?.stack ?? error}`);
      sendError(res, 500, 'internal', error?.message ?? 'internal error');
    }
  }

  return { handler };
}
