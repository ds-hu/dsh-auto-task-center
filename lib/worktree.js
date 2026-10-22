/**
 * The optional worktree integration.
 *
 * `dsh-better-workspaces` publishes no Cordis service — its own patch file says
 * so — so the only contract between the two plugins is the HTTP surface it
 * mounts beside ours under `/better-workspaces/api`. This module is that
 * contract and nothing else: a presence probe, a branch listing, and one
 * creation call, all over loopback with a typed result instead of a throw.
 *
 * Two rules shape the code:
 *
 * - **Absence is normal.** The other plugin is optional, so a missing route, a
 *   refused connection and a slow answer are all just `ok: false` values. The
 *   panel hides its control; nothing logs a stack trace.
 * - **Its fence is an origin fence, not authentication.** A mutating call must
 *   carry `Origin` matching `Host`, exactly as its own browser client does, so
 *   this module sets that header itself instead of pretending to be anonymous.
 *
 * @module @ds-hu/dsh-auto-task-center/lib/worktree
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

/** How long one probe result is trusted. */
const PROBE_TTL_MS = 5 * 60_000;
/** Budget for a read (probe, branches, detect). */
const READ_TIMEOUT_MS = 15_000;
/** Budget for `git worktree add`, which copies a checkout on large repositories. */
const CREATE_TIMEOUT_MS = 60_000;
/** Longest branch slug this plugin proposes; the other side adds its own suffix. */
const MAX_SLUG = 40;

/** A worktree operation that could not complete, with a stable reason. */
export class WorktreeError extends Error {
  /**
   * @param {string} code - Stable machine code the panel localises.
   * @param {string} message - Human-readable explanation.
   * @param {object} [detail] - Extra fields worth keeping (upstream message, status).
   */
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'WorktreeError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Send one JSON request and parse whatever comes back.
 *
 * `node:http` rather than `fetch` because the request must carry an `Origin`
 * header, which the Fetch standard forbids callers from setting.
 *
 * @param {string} url - Absolute loopback URL.
 * @param {object} [options] - Request options.
 * @param {'GET' | 'POST'} [options.method] - HTTP method.
 * @param {Record<string, string>} [options.headers] - Extra headers.
 * @param {unknown} [options.body] - Value serialized as JSON.
 * @param {number} [options.timeoutMs] - Budget for the whole exchange.
 * @returns {Promise<{ status: number, payload: any }>} the response.
 */
function httpJson(url, { method = 'GET', headers = {}, body, timeoutMs = READ_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch (error) {
      reject(error);
      return;
    }
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const text = body === undefined ? undefined : JSON.stringify(body);
    const request = send({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method,
      headers: {
        accept: 'application/json',
        ...(text === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }),
        ...headers,
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let payload;
        try {
          payload = raw === '' ? null : JSON.parse(raw);
        } catch {
          payload = null;
        }
        resolve({ status: response.statusCode ?? 0, payload: payload ?? null });
      });
      response.on('error', reject);
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`no answer within ${timeoutMs} ms`));
    });
    request.on('error', reject);
    if (text !== undefined) request.write(text);
    request.end();
  });
}

/**
 * Turn a task name into a branch slug the other side accepts.
 *
 * Anything non-ASCII disappears, so a Chinese task name yields an empty slug and
 * the worktree gets the other side's mnemonic name instead of a broken one.
 *
 * @param {string} name - Task name.
 * @returns {string} a slug, or an empty string when nothing usable is left.
 */
export function slugForTaskName(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/u, '');
}

/**
 * Build the client for one Host origin.
 *
 * @param {object} options - Client options.
 * @param {() => string} options.origin - Reads the current Host origin; the server may bind after mount.
 * @param {(level: string, message: string) => void} [options.logger] - Diagnostic sink.
 * @param {() => number} [options.now] - Clock, injectable for tests.
 * @returns {{
 *   probe: () => Promise<{ present: boolean, reason?: string }>,
 *   options: (input: { repoPath: string }) => Promise<Record<string, any>>,
 *   create: (input: { repoPath: string, base?: string, slug?: string }) => Promise<Record<string, any>>,
 * }} the client.
 */
export function createWorktreeClient({ origin, logger = () => {}, now = () => Date.now() }) {
  /** @type {{ at: number, value: { present: boolean, reason?: string } } | undefined} */
  let cached;

  /**
   * Call one surface route, translating transport failures into a reason.
   * @param {string} path - Path below the plugin prefix.
   * @param {object} [options] - Options passed through to {@link httpJson}.
   * @returns {Promise<{ ok: boolean, status?: number, payload?: any, reason?: string }>} the exchange.
   */
  async function call(path, options = {}) {
    const base = origin();
    if (typeof base !== 'string' || base === '') return { ok: false, reason: 'no-origin' };
    const url = `${base.replace(/\/+$/u, '')}/better-workspaces/api${path}`;
    try {
      const { status, payload } = await httpJson(url, {
        ...options,
        headers: { origin: base, ...(options.headers ?? {}) },
      });
      return { ok: true, status, payload };
    } catch (error) {
      return { ok: false, reason: error?.message ?? String(error) };
    }
  }

  /**
   * Whether the other plugin answers at all.
   *
   * The listing route is the cheapest truthful signal: it neither runs git nor
   * needs arguments, so a 200 with `ok` means mounted, and anything else —
   * including the shell's own 404 — means absent.
   *
   * @param {boolean} [refresh] - Ignore the cached answer.
   * @returns {Promise<{ present: boolean, reason?: string }>} the probe result.
   */
  async function probe(refresh = false) {
    const at = now();
    if (!refresh && cached !== undefined && at - cached.at < PROBE_TTL_MS) return cached.value;
    const answer = await call('/worktree-workspaces');
    let value;
    if (!answer.ok) value = { present: false, reason: answer.reason };
    else if (answer.status === 200 && answer.payload?.ok === true) value = { present: true };
    else value = { present: false, reason: `status ${answer.status}` };
    cached = { at: now(), value };
    if (!value.present) logger('debug', `task-center: better-workspaces is not available (${value.reason})`);
    return value;
  }

  /**
   * Branch choices for one repository.
   *
   * @param {{ repoPath: string }} input - Repository directory.
   * @returns {Promise<Record<string, any>>} `{ ok, defaultBranch, branches }` or a refusal.
   */
  async function options({ repoPath }) {
    const answer = await call(`/detect?path=${encodeURIComponent(repoPath)}`);
    if (!answer.ok) throw new WorktreeError('worktree-unavailable', `better-workspaces did not answer: ${answer.reason}`);
    if (answer.status === 404) throw new WorktreeError('worktree-unavailable', 'better-workspaces is not mounted');
    if (answer.status !== 200 || answer.payload?.ok !== true) {
      throw new WorktreeError('worktree-unavailable', answer.payload?.message ?? `detect failed with status ${answer.status}`);
    }
    if (answer.payload.isGit !== true) return { ok: true, isGit: false, defaultBranch: null, branches: [] };
    // A linked worktree has its own root; branches must be read from it, not guessed.
    const branchAnswer = await call(`/branches?cwd=${encodeURIComponent(repoPath)}`);
    if (branchAnswer.status === 200 && branchAnswer.payload?.ok === true) {
      const branches = Array.isArray(branchAnswer.payload.branches) ? branchAnswer.payload.branches : [];
      return {
        ok: true,
        isGit: true,
        defaultBranch: branchAnswer.payload.defaultBranch ?? answer.payload.defaultBranch ?? null,
        branches: branches.map((branch) => (typeof branch === 'string' ? branch : branch?.name)).filter((name) => typeof name === 'string'),
      };
    }
    return { ok: true, isGit: true, defaultBranch: answer.payload.defaultBranch ?? null, branches: [] };
  }

  /**
   * Create one managed worktree off a base branch.
   *
   * The creation transaction id and source session are deliberately omitted:
   * this plugin has no source session, and the other side supports exactly that
   * shape — its guard only applies when a draft is being handed over.
   *
   * @param {{ repoPath: string, base?: string, slug?: string }} input - Repository, base branch, branch slug.
   * @returns {Promise<{ path: string, branch: string, workspaceId?: string }>} the created worktree.
   * @throws {WorktreeError} always with a stable code.
   */
  async function create({ repoPath, base, slug }) {
    const body = {
      cwd: repoPath,
      intent: 'branch-off',
      ...(typeof base === 'string' && base !== '' ? { base } : {}),
      ...(typeof slug === 'string' && slug !== '' ? { slug } : {}),
    };
    const answer = await call('/worktrees', { method: 'POST', body, timeoutMs: CREATE_TIMEOUT_MS });
    if (!answer.ok) {
      throw new WorktreeError('worktree-unavailable', `better-workspaces did not answer: ${answer.reason}`);
    }
    const payload = answer.payload ?? {};
    if (answer.status === 404) throw new WorktreeError('worktree-unavailable', 'better-workspaces is not mounted');
    if ((answer.status === 200 || answer.status === 201) && payload.ok === true && typeof payload.path === 'string') {
      return {
        path: payload.path,
        branch: typeof payload.branch === 'string' ? payload.branch : '',
        ...(typeof payload.workspaceId === 'string' ? { workspaceId: payload.workspaceId } : {}),
      };
    }
    const upstream = typeof payload.message === 'string' && payload.message !== ''
      ? payload.message
      : (typeof payload.error === 'string' ? payload.error : `status ${answer.status}`);
    if (answer.status === 403 || /git repository required|git repository root/iu.test(upstream)) {
      throw new WorktreeError('worktree-not-git-root', upstream, { status: answer.status });
    }
    if (answer.status === 422) throw new WorktreeError('worktree-base-invalid', upstream, { status: answer.status });
    throw new WorktreeError('worktree-create-failed', upstream, { status: answer.status });
  }

  return { probe, options, create };
}
