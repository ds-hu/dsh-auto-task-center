/**
 * dsh-auto-task-center — Host half.
 *
 * Owns the whole plugin: the task store, the scheduler, the panel API and the
 * webhook route. The agent tool is registered separately by
 * `@ds-hu/dsh-auto-task-center/tools`, which a preset mounts into its own
 * scope.
 *
 * Everything this plugin writes lives under `$DSH_HOME/task-center/` and
 * nothing else is touched, which is what makes uninstalling clean: remove the
 * bundle, delete that one directory, done. See `docs/TECHNICAL.md#uninstall`.
 *
 * `webServer` and `sessionController` are hard dependencies — without the first
 * there is no panel and no webhook, without the second nothing can be
 * delivered, so the plugin stays inert until both exist. `workspaceRegistry`,
 * `agentPresets` and `commands` are read opportunistically and each degrades on
 * its own: no workspace list falls back to a directory field, no preset roster
 * falls back to a text field, and no command service makes `/goal` mode report
 * a missing capability instead of failing silently.
 *
 * `dsh-better-workspaces` is optional and is never imported. When it answers on
 * this Host's origin, a task may ask for a fresh worktree per run; without it the
 * panel hides the option and a task that still wants one fails honestly instead of
 * falling back to the repository checkout.
 *
 * @module @ds-hu/dsh-auto-task-center
 */
import { createApi } from './api.js';
import { createDeliverer } from './deliver.js';
import { createScheduler } from './scheduler.js';
import { createStore, resolveDataDir } from './store.js';
import { setRuntime } from './runtime.js';
import { createWorktreeClient } from './worktree.js';
import { PLUGIN_VERSION } from './version.js';

/** Plugin name registered with the Loader; must equal the row `id` in cordis.patch.yml. */
export const name = 'dsh-auto-task-center';

/** Host services this plugin cannot work without. */
export const inject = ['webServer', 'sessionController'];

/**
 * Mount the plugin.
 * @param {any} ctx - Host plugin context (Cordis).
 * @returns {void}
 */
export function apply(ctx) {
  /**
   * Route diagnostics through the Host log when it exposes one, and stay quiet
   * enough otherwise that a bare profile is not noisy.
   * @param {string} level - Severity.
   * @param {string} message - Text to record.
   * @returns {void}
   */
  const logger = (level, message) => {
    const sink = ctx.get?.('logger');
    if (typeof sink === 'function') {
      sink.call(ctx, level, message);
      return;
    }
    if (typeof sink?.log === 'function') {
      sink.log(level, message);
      return;
    }
    if (level === 'error' || level === 'warn') console.warn(message);
  };

  const dir = resolveDataDir();
  const store = createStore({ dir, logger });
  const loaded = store.load();
  if (loaded.dropped > 0 || loaded.quarantined !== undefined) {
    logger('warn', `task-center: loaded ${loaded.loaded} task(s), dropped ${loaded.dropped}`
      + (loaded.quarantined === undefined ? '' : `, quarantined the damaged file to ${loaded.quarantined}`));
  }

  /** The Host origin, resolved lazily because the server may bind after mount. */
  const originOf = () => {
    try {
      return ctx.webServer.getOrigin();
    } catch {
      return '';
    }
  };

  // The worktree integration is optional: it answers over the same Host origin
  // and simply reports itself absent when that plugin is not installed.
  const worktrees = createWorktreeClient({ origin: originOf, logger });

  const deliverer = createDeliverer({ ctx, logger, worktrees });
  const scheduler = createScheduler({ store, deliverer, logger });
  setRuntime({ store, scheduler, ctx, now: () => Date.now() });

  const api = createApi({
    store,
    scheduler,
    ctx,
    worktrees,
    origin: originOf,
    version: PLUGIN_VERSION,
    logger,
  });

  ctx.effect(() => {
    const unregister = ctx.webServer.register({
      kind: 'prefix',
      path: '/task-center',
      handler: api.handler,
    });
    const started = scheduler.start().catch((error) => {
      logger('error', `task-center: the scheduler failed to start: ${error?.message ?? error}`);
    });
    let disposed = false;
    return async () => {
      if (disposed) return;
      disposed = true;
      unregister();
      await scheduler.stop();
      await started;
      await store.close();
      setRuntime(undefined);
    };
  }, 'task-center: routes and schedule');
}
