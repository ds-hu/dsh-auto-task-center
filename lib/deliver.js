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
 * @returns {{ deliver: (input: { task: Record<string, any>, payload?: string, signal: AbortSignal }) => Promise<{ sessionId: string }> }} the deliverer.
 */
export function createDeliverer({ ctx, logger = () => {} }) {
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
   * Find or create the session a task delivers into.
   * @param {Record<string, any>} target - Stored target.
   * @returns {Promise<string>} the session identity.
   */
  async function resolveSession(target) {
    if (target.kind === 'session') return target.sessionId;
    if (target.kind !== 'newSession') throw new DeliveryError('target-invalid', `unknown target kind ${String(target.kind)}`);
    if (ctx.sessionController === undefined) {
      throw new DeliveryError('session-service-missing', 'this profile composes no session service');
    }
    try {
      const created = await ctx.sessionController.create({
        ...(target.workspaceId === undefined ? {} : { workspaceId: target.workspaceId }),
        ...(target.cwd === undefined ? {} : { cwd: target.cwd }),
        ...(target.agentPreset === undefined ? {} : { agentPreset: target.agentPreset }),
      });
      return created.sessionId;
    } catch (error) {
      throw new DeliveryError('create-failed', `cannot open a session in ${target.workspaceId ?? target.cwd ?? '?'}: ${error?.message ?? error}`);
    }
  }

  /**
   * Send one task's body to its target.
   * @param {{ task: Record<string, any>, payload?: string, signal: AbortSignal }} input - The task and the webhook payload, if any.
   * @returns {Promise<{ sessionId: string }>} the session that received it.
   */
  async function deliver({ task, payload, signal }) {
    const text = renderMessage(task.message.text, payload);
    const sessionId = await resolveSession(task.target);
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
      logger('debug', `task-center: goal started in ${sessionId}`);
      return { sessionId };
    }
    const clientTimeZone = hostTimeZone();
    await ctx.sessionController.prompt({
      requestId: randomUUID(),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
      ...(clientTimeZone === undefined ? {} : { clientTimeZone }),
    }, signal);
    logger('debug', `task-center: message delivered to ${sessionId}`);
    return { sessionId };
  }

  return { deliver };
}
