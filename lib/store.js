/**
 * The task store: one JSON document, written atomically, read defensively.
 *
 * Everything the plugin persists lives in exactly one file under one directory
 * (`$DSH_HOME/task-center/tasks.json`). The directory is created lazily — a
 * profile that installs the plugin and never creates a task gets no directory
 * at all — and uninstalling means deleting that one directory. See
 * `docs/TECHNICAL.md#uninstall`.
 *
 * @module @ds-hu/dsh-auto-task-center/lib/store
 */
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { sanitizeStoredTask } from './model.js';

/** Current on-disk document version. */
export const STORE_VERSION = 1;
/** File name inside the data directory. */
export const STORE_FILE = 'tasks.json';

/**
 * @typedef {(level: 'debug' | 'info' | 'warn' | 'error', message: string) => void} Logger
 */

/**
 * Open the store and load whatever is already on disk.
 *
 * Loading never throws: an unreadable file is quarantined, a damaged record is
 * dropped, and the Host starts with whatever survived.
 *
 * @param {object} options - Store options.
 * @param {string} options.dir - Absolute data directory.
 * @param {Logger} [options.logger] - Sink for load and write diagnostics.
 * @returns {object} the store.
 */
export function createStore({ dir, logger = () => {} }) {
  const filePath = join(dir, STORE_FILE);
  /** @type {Map<string, Record<string, any>>} */
  const tasks = new Map();
  /** @type {Set<() => void>} */
  const listeners = new Set();
  let chain = Promise.resolve();
  let closed = false;
  let loaded = 0;
  let dropped = 0;
  let quarantined;

  /**
   * Resolve the quarantine path for a damaged store file.
   * @returns {string} a sibling path that does not collide with an earlier quarantine.
   */
  function quarantinePath() {
    const stamp = new Date().toISOString().replaceAll(':', '-');
    return join(dir, `tasks.corrupt-${stamp}.json`);
  }

  /**
   * Read and validate the store file into memory.
   * @returns {{ loaded: number, dropped: number, quarantined?: string }} the load summary.
   */
  function load() {
    tasks.clear();
    loaded = 0;
    dropped = 0;
    quarantined = undefined;
    let text;
    try {
      text = readFileSync(filePath, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') logger('warn', `task-center: cannot read ${filePath}: ${error?.message ?? error}`);
      return { loaded, dropped };
    }
    let doc;
    try {
      doc = JSON.parse(text);
    } catch (error) {
      const target = quarantinePath();
      try {
        renameSync(filePath, target);
        quarantined = target;
        logger('error', `task-center: ${filePath} is not valid JSON; moved to ${target}: ${error?.message ?? error}`);
      } catch (renameError) {
        logger('error', `task-center: ${filePath} is not valid JSON and could not be quarantined: ${renameError?.message ?? renameError}`);
      }
      return { loaded, dropped, ...(quarantined === undefined ? {} : { quarantined }) };
    }
    const version = typeof doc?.version === 'number' ? doc.version : STORE_VERSION;
    if (version > STORE_VERSION) {
      logger('warn', `task-center: ${filePath} has version ${version}, newer than ${STORE_VERSION}; reading it anyway`);
    }
    const rawTasks = Array.isArray(doc?.tasks)
      ? doc.tasks
      : (typeof doc?.tasks === 'object' && doc.tasks !== null ? Object.values(doc.tasks) : []);
    for (const raw of rawTasks) {
      const task = sanitizeStoredTask(raw);
      if (task === null) {
        dropped += 1;
        logger('warn', `task-center: dropped an unreadable task record (${JSON.stringify(raw?.id ?? null)})`);
        continue;
      }
      if (tasks.has(task.id)) {
        dropped += 1;
        logger('warn', `task-center: dropped a duplicate task record (${task.id})`);
        continue;
      }
      tasks.set(task.id, task);
      loaded += 1;
    }
    return { loaded, dropped, ...(quarantined === undefined ? {} : { quarantined }) };
  }

  /**
   * The serialized document for the current in-memory state.
   * @returns {{ version: number, tasks: Record<string, Record<string, any>> }} the document.
   */
  function document() {
    return { version: STORE_VERSION, tasks: Object.fromEntries(tasks) };
  }

  /**
   * Write the whole document, atomically.
   *
   * A temporary sibling plus a rename means a reader sees either the previous
   * file or the new one, never a half-written one.
   *
   * @returns {Promise<void>} resolves once the rename has landed.
   */
  async function writeDocument() {
    const text = `${JSON.stringify(document(), null, 2)}\n`;
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temporary = `${filePath}.tmp-${process.pid}-${Math.random().toString(16).slice(2, 10)}`;
    try {
      await writeFile(temporary, text, { mode: 0o600, encoding: 'utf8' });
      await rename(temporary, filePath);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }

  /**
   * Run one write after every earlier write has settled.
   * @template T
   * @param {() => Promise<T>} work - The write.
   * @returns {Promise<T>} the write's own result, so callers can report failure.
   */
  function enqueue(work) {
    const run = chain.then(work);
    chain = run.then(() => {}, () => {});
    return run;
  }

  /** Notify listeners about a committed in-memory change. */
  function notify() {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        logger('warn', `task-center: a store listener threw: ${error?.message ?? error}`);
      }
    }
  }

  /**
   * Ask the Host to re-read its task list.
   * @param {() => void} listener - Called after every committed change.
   * @returns {() => void} unsubscribe.
   */
  function onChange(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  /**
   * Every task, in insertion order.
   * @returns {Record<string, any>[]} detached copies, so callers cannot mutate the store by accident.
   */
  function list() {
    return [...tasks.values()].map((task) => structuredClone(task));
  }

  /**
   * One task by identity.
   * @param {string} id - Task identity.
   * @returns {Record<string, any> | undefined} a detached copy.
   */
  function get(id) {
    const task = tasks.get(id);
    return task === undefined ? undefined : structuredClone(task);
  }

  /**
   * Store one record and persist.
   * @param {Record<string, any>} record - Complete record.
   * @returns {Promise<void>} resolves once it is on disk.
   */
  function put(record) {
    if (closed) return Promise.reject(new Error('task-center: the store is closed'));
    tasks.set(record.id, record);
    notify();
    return enqueue(writeDocument);
  }

  /**
   * Delete one record and persist.
   * @param {string} id - Task identity.
   * @returns {Promise<boolean>} whether a record was removed.
   */
  function remove(id) {
    if (closed) return Promise.reject(new Error('task-center: the store is closed'));
    if (!tasks.delete(id)) return Promise.resolve(false);
    notify();
    return enqueue(writeDocument).then(() => true);
  }

  /**
   * Apply a change to one record and persist it.
   * @param {string} id - Task identity.
   * @param {(task: Record<string, any>) => void} change - Mutates the detached copy.
   * @returns {Promise<Record<string, any> | undefined>} the stored record, or undefined when it is gone.
   */
  function update(id, change) {
    const current = tasks.get(id);
    if (current === undefined) return Promise.resolve(undefined);
    const draft = structuredClone(current);
    change(draft);
    draft.updatedAt = new Date().toISOString();
    return put(draft).then(() => structuredClone(draft));
  }

  /**
   * Wait for every queued write, then stop accepting new ones.
   * @returns {Promise<void>} resolves when the last write settled.
   */
  async function close() {
    closed = true;
    await chain;
    listeners.clear();
  }

  return {
    dir,
    filePath,
    load,
    list,
    get,
    put,
    remove,
    update,
    onChange,
    close,
    get size() {
      return tasks.size;
    },
    summary: () => ({ loaded, dropped, ...(quarantined === undefined ? {} : { quarantined }) }),
  };
}

/**
 * The data directory for a DSH home.
 * @param {NodeJS.ProcessEnv} [env] - Environment to read; defaults to `process.env`.
 * @returns {string} the absolute directory holding the store.
 */
export function resolveDataDir(env = process.env) {
  const home = env.DSH_HOME === undefined || env.DSH_HOME === '' ? join(env.HOME ?? env.USERPROFILE ?? '.', '.dsh') : env.DSH_HOME;
  return join(home, 'task-center');
}
