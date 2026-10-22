/**
 * Delivery: turn one due task into something that actually happens in a
 * session.
 *
 * Two shapes, chosen per task:
 *
 * - **message** — the body goes in as an ordinary user message, so the Host
 *   treats it exactly like something typed into the composer. In particular a
 *   `/skill-name` token inside it is picked up, because `dsh-tool-skill` scans
 *   claimed messages whose `source.kind` is `user` and
 *   `sessionController.prompt()` mints precisely that source.
 * - **goal** — the same text is executed as a `/goal <text>` command instead,
 *   which requires the command service and a live agent for the target session.
 *
 * @module @ds-hu/dsh-auto-task-center/lib/deliver
 */
import { randomUUID } from 'node:crypto';
import { slugForTaskName } from './worktree.js';

/** Characters of a webhook payload spliced into one message. */
const MAX_PAYLOAD_CHARS = 4000;

/** A delivery that could not happen, with a stable reason. */
export class DeliveryError extends Error {
  /**
   * @param {string} code - Stable machine code.
   * @param {string} message - Human-readable explanation.
   */
  constructor(code, message) {
    super(message);
    this.name = 'DeliveryError';
    this.code = code;
  }
}

/**
 * Splice a webhook payload into a message body.
 *
 * `{{payload}}` is always replaced — with an empty string for a timed run, so a
 * task shared between a timer and a webhook never shows the placeholder.
 *
 * @param {string} text - Task body.
 * @param {string | undefined} payload - Webhook body, when there is one.
 * @returns {string} the message to send.
 */
export function renderMessage(text, payload) {
  const value = (payload ?? '').slice(0, MAX_PAYLOAD_CHARS);
  return text.replaceAll('{{payload}}', value);
}

/**
 * Build the delivery half of the plugin.
 *
 * @param {object} options - Delivery options.
 * @param {any} options.ctx - Host plugin context (Cordis).
 * @param {(level: string, message: string) => void} [options.logger] - Diagnostic sink.
 * @param {ReturnType<typeof import('./worktree.js').createWorktreeClient>} [options.worktrees] - The optional worktree integration.
 * @returns {{ deliver: (input: { task: Record<string, any>, payload?: string, signal: AbortSignal }) => Promise<{ sessionId: string, worktree?: { path: string, branch: string } }> }} the deliverer.
 */
export function createDeliverer({ ctx, logger = () => {}, worktrees }) {
  /**
   * The zone a delivered message is stamped with. There is no browser at
   * delivery time, so the Host's own zone is the honest choice.
   * @returns {string | undefined} an IANA zone id when the runtime reports one.
   */
  function hostTimeZone() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return undefined;
    }
  }

  /**
   * Path of one registered workspace.
   *
   * A worktree is created inside a repository, so the run needs the directory
   * behind the workspace id — and a workspace that is gone is a delivery
   * failure, not a reason to guess.
   *
   * @param {string} workspaceId - Workspace identity.
   * @returns {string} its root directory.
   */
  function workspacePath(workspaceId) {
    const rows = ctx.get?.('workspaceRegistry')?.list?.() ?? [];
    const hit = Array.isArray(rows) ? rows.find((row) => (row?.workspaceId ?? row?.id) === workspaceId) : undefined;
    const path = hit?.path;
    if (typeof path !== 'string' || path === '') {
      throw new DeliveryError('workspace-missing', `workspace ${workspaceId} is no longer registered, so no worktree can be created in it`);
    }
    return path;
  }

  /**
   * Create the fresh worktree one run delivers into.
   *
   * The base branch is resolved by the other plugin at run time, so a task that
   * pins `main` always branches off main's current tip. Failure here never falls
   * back to the repository checkout: an agent editing the user's working copy is
   * exactly the outcome a worktree target exists to avoid.
   *
   * @param {Record<string, any>} task - Stored task.
   * @returns {Promise<{ path: string, branch: string, workspaceId?: string }>} the new worktree.
   */
  async function freshWorktree(task) {
    if (worktrees === undefined) {
      throw new DeliveryError('worktree-unavailable', 'this task delivers into a fresh worktree, but dsh-better-workspaces is not installed');
    }
    const available = await worktrees.probe();
    if (!available.present) {
      throw new DeliveryError('worktree-unavailable', `this task delivers into a fresh worktree, but dsh-better-workspaces is not answering (${available.reason ?? 'absent'})`);
    }
    const repoPath = workspacePath(task.target.workspaceId);
    try {
      return await worktrees.create({
        repoPath,
        base: task.target.worktree?.base,
        slug: slugForTaskName(task.name),
      });
    } catch (error) {
      if (error?.name === 'WorktreeError') throw new DeliveryError(error.code, error.message);
      throw error;
    }
  }

  /**
   * Find or create the session a task delivers into.
   * @param {Record<string, any>} task - Stored task.
   * @returns {Promise<{ sessionId: string, worktree?: { path: string, branch: string } }>} the session and any worktree made for it.
   */
  async function resolveSession(task) {
    const target = task.target;
    if (target.kind === 'session') return { sessionId: target.sessionId };
    if (target.kind !== 'newSession') throw new DeliveryError('target-invalid', `unknown target kind ${String(target.kind)}`);
    if (ctx.sessionController === undefined) {
      throw new DeliveryError('session-service-missing', 'this profile composes no session service');
    }
    const created = target.worktree === undefined ? undefined : await freshWorktree(task);
    // A worktree replaces the location: the other plugin registers it as a
    // workspace, and when it hands back that identity the session joins it,
    // otherwise the session simply owns the new directory.
    const location = created === undefined
      ? {
          ...(target.workspaceId === undefined ? {} : { workspaceId: target.workspaceId }),
          ...(target.cwd === undefined ? {} : { cwd: target.cwd }),
        }
      : (created.workspaceId === undefined ? { cwd: created.path } : { workspaceId: created.workspaceId });
    try {
      const session = await ctx.sessionController.create({
        ...location,
        ...(target.agentPreset === undefined ? {} : { agentPreset: target.agentPreset }),
      });
      return {
        sessionId: session.sessionId,
        ...(created === undefined ? {} : { worktree: { path: created.path, branch: created.branch } }),
      };
    } catch (error) {
      throw new DeliveryError('create-failed', `cannot open a session in ${created?.path ?? target.workspaceId ?? target.cwd ?? '?'}: ${error?.message ?? error}`);
    }
  }

  /**
   * Send one task's body to its target.
   * @param {{ task: Record<string, any>, payload?: string, signal: AbortSignal }} input - The task and the webhook payload, if any.
   * @returns {Promise<{ sessionId: string, worktree?: { path: string, branch: string } }>} the session that received it.
   */
  async function deliver({ task, payload, signal }) {
    const text = renderMessage(task.message.text, payload);
    const { sessionId, worktree } = await resolveSession(task);
    const made = worktree === undefined ? {} : { worktree };
    if (task.message.goalMode) {
      const commands = ctx.get?.('commands');
      if (commands === undefined) {
        throw new DeliveryError('commands-unavailable', 'this profile composes no command service, so /goal cannot run');
      }
      const resolved = await ctx.sessionController.resolveAgent(sessionId);
      if (resolved.error !== undefined) {
        throw new DeliveryError('target-missing', `cannot open session ${sessionId}: ${resolved.error.message ?? resolved.error.code ?? 'unknown'}`);
      }
      const execution = await commands.execute(resolved.agent, `/goal ${text}`, [], signal);
      if (execution === undefined) {
        throw new DeliveryError('goal-rejected', 'the /goal command is not available to this session');
      }
      logger('debug', `task-center: goal started in ${sessionId}${worktree === undefined ? '' : ` in worktree ${worktree.branch}`}`);
      return { sessionId, ...made };
    }
    const clientTimeZone = hostTimeZone();
    await ctx.sessionController.prompt({
      requestId: randomUUID(),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
      ...(clientTimeZone === undefined ? {} : { clientTimeZone }),
    }, signal);
    logger('debug', `task-center: message delivered to ${sessionId}${worktree === undefined ? '' : ` in worktree ${worktree.branch}`}`);
    return { sessionId, ...made };
  }

  return { deliver };
}
