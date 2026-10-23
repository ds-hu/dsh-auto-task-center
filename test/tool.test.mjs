import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setRuntime } from '../lib/runtime.js';
import { TASK_CENTER_TOOL } from '../lib/tool-definition.js';
import { createScheduler } from '../lib/scheduler.js';
import { createStore } from '../lib/store.js';

const BASE = Date.parse('2026-06-01T08:00:00Z');

/**
 * Install a runtime backed by a throwaway store.
 * @returns {Promise<{ store: any, restore: () => void, cleanup: () => Promise<void> }>} the harness.
 */
async function withRuntime() {
  const dir = await mkdtemp(join(tmpdir(), 'task-center-tool-'));
  const store = createStore({ dir });
  store.load();
  const deliverer = { async deliver() { return { sessionId: 'sess-1' }; } };
  const scheduler = createScheduler({ store, deliverer, now: () => BASE });
  setRuntime({ store, scheduler, ctx: {}, now: () => BASE });
  return {
    store,
    restore: () => setRuntime(undefined),
    async cleanup() {
      setRuntime(undefined);
      await scheduler.stop();
      await store.close();
    },
  };
}

/** A tool execution context bound to one session. */
function exec(sessionId = 'caller-session') {
  return { agent: { session: { id: sessionId } } };
}

test('tool: the definition matches what the registry needs', () => {
  assert.equal(TASK_CENTER_TOOL.name, 'task_center');
  assert.equal(TASK_CENTER_TOOL.parameters.type, 'object');
  assert.deepEqual(TASK_CENTER_TOOL.parameters.required, ['action']);
  assert.deepEqual(TASK_CENTER_TOOL.parameters.properties.action.enum, ['create', 'list', 'update', 'delete']);
  assert.equal(TASK_CENTER_TOOL.output.schema.type, 'object');
  const rendered = TASK_CENTER_TOOL.output.render({}, { ok: true });
  assert.equal(rendered[0].type, 'text');
  assert.match(rendered[0].text, /"ok": true/u);
  assert.match(TASK_CENTER_TOOL.description, /Host-wide/u);
  assert.match(TASK_CENTER_TOOL.description, /\/skill-name/u);
});

test('tool: a missing runtime is reported, not thrown', async () => {
  setRuntime(undefined);
  const result = await TASK_CENTER_TOOL.execute({ action: 'list' }, exec());
  assert.equal(result.ok, false);
  assert.equal(result.code, 'not-mounted');
});

test('tool: list starts empty and create defaults to the calling session', async () => {
  const harness = await withRuntime();
  try {
    assert.deepEqual(await TASK_CENTER_TOOL.execute({ action: 'list' }, exec()), { ok: true, count: 0, tasks: [] });
    const created = await TASK_CENTER_TOOL.execute({
      action: 'create',
      name: 'from the model',
      trigger: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' },
      message: { text: 'check the build' },
    }, exec('caller-session'));
    assert.equal(created.ok, true);
    assert.equal(created.task.target.kind, 'session');
    assert.equal(created.task.target.sessionId, 'caller-session');
    assert.ok(created.task.state.nextAt);

    const listed = await TASK_CENTER_TOOL.execute({ action: 'list' }, exec());
    assert.equal(listed.count, 1);
    assert.equal(listed.tasks[0].name, 'from the model');
    assert.match(listed.tasks[0].trigger, /daily 09:00:00 Asia\/Shanghai/u);
    assert.match(listed.tasks[0].target, /caller-session/u);
  } finally {
    await harness.cleanup();
  }
});

test('tool: create without a target and without an agent is a clean refusal', async () => {
  const harness = await withRuntime();
  try {
    const result = await TASK_CENTER_TOOL.execute({
      action: 'create',
      name: 'nowhere',
      trigger: { kind: 'daily', time: '09:00', timeZone: 'UTC' },
      message: { text: 'x' },
    }, {});
    assert.equal(result.ok, false);
    assert.equal(result.code, 'target/missing');
  } finally {
    await harness.cleanup();
  }
});

test('tool: webhook secrets never reach the model', async () => {
  const harness = await withRuntime();
  try {
    const created = await TASK_CENTER_TOOL.execute({
      action: 'create',
      name: 'hooked',
      trigger: { kind: 'webhook' },
      message: { text: 'x' },
    }, exec());
    assert.equal(created.task.trigger.secret, '***');
    const stored = harness.store.list()[0];
    assert.match(stored.trigger.secret, /^[0-9a-f]{32}$/u);
  } finally {
    await harness.cleanup();
  }
});

test('tool: update replaces the editable fields and keeps history', async () => {
  const harness = await withRuntime();
  try {
    const created = await TASK_CENTER_TOOL.execute({
      action: 'create',
      name: 'first',
      trigger: { kind: 'every', everySeconds: 3600 },
      message: { text: 'x' },
    }, exec());
    const id = created.task.id;
    const updated = await TASK_CENTER_TOOL.execute({
      action: 'update',
      id,
      name: 'second',
      enabled: false,
    }, exec());
    assert.equal(updated.ok, true);
    assert.equal(updated.task.name, 'second');
    assert.equal(updated.task.enabled, false);
    assert.equal(updated.task.trigger.kind, 'every');
    assert.equal(updated.task.id, id);

    const missing = await TASK_CENTER_TOOL.execute({ action: 'update', id: 'task-nope' }, exec());
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'not-found');
  } finally {
    await harness.cleanup();
  }
});

test('tool: delete removes the task and reports a second attempt', async () => {
  const harness = await withRuntime();
  try {
    const created = await TASK_CENTER_TOOL.execute({
      action: 'create',
      name: 'gone',
      trigger: { kind: 'daily', time: '09:00', timeZone: 'UTC' },
      message: { text: 'x' },
    }, exec());
    const removed = await TASK_CENTER_TOOL.execute({ action: 'delete', id: created.task.id }, exec());
    assert.deepEqual(removed, { ok: true, deleted: created.task.id });
    const again = await TASK_CENTER_TOOL.execute({ action: 'delete', id: created.task.id }, exec());
    assert.equal(again.ok, false);
    assert.equal(again.code, 'not-found');
  } finally {
    await harness.cleanup();
  }
});

test('tool: invalid arguments are rejected by the definition itself', async () => {
  const harness = await withRuntime();
  try {
    await assert.rejects(() => TASK_CENTER_TOOL.execute({}, exec()), /"action"/u);
    await assert.rejects(() => TASK_CENTER_TOOL.execute({ action: 'run', id: 'x' }, exec()), /must be one of create, list, update, delete/u);
    await assert.rejects(() => TASK_CENTER_TOOL.execute({ action: 'delete' }, exec()), /needs the task id/u);
  } finally {
    await harness.cleanup();
  }
});

test('tool: the schema exposes the optional worktree modifier', () => {
  const target = TASK_CENTER_TOOL.parameters.properties.target;
  assert.equal(target.properties.worktree.type, 'object');
  assert.equal(target.properties.worktree.properties.base.type, 'string');
  assert.match(target.description, /worktree/u);
  assert.match(TASK_CENTER_TOOL.description, /target\.worktree/u);
});

test('tool: create accepts a worktree target and list names it', async () => {
  const harness = await withRuntime();
  try {
    const created = await TASK_CENTER_TOOL.execute({
      action: 'create',
      name: 'nightly',
      trigger: { kind: 'every', everySeconds: 3600 },
      target: { kind: 'newSession', workspaceId: 'ws-1', worktree: { base: 'main' } },
      message: { text: 'run the checks' },
    }, exec());
    assert.equal(created.ok, true);
    const stored = harness.store.get(created.task.id);
    assert.deepEqual(stored.target.worktree, { base: 'main' });

    const listed = await TASK_CENTER_TOOL.execute({ action: 'list' }, exec());
    assert.equal(listed.ok, true);
    assert.match(JSON.stringify(listed), /fresh worktree off main/u);
  } finally {
    await harness.cleanup();
  }
});

test('tool: the schema exposes the model and permission of a new session', () => {
  const target = TASK_CENTER_TOOL.parameters.properties.target;
  assert.equal(target.properties.model.type, 'object');
  assert.deepEqual(target.properties.model.required, ['provider', 'model']);
  assert.equal(target.properties.permission.type, 'string');
  assert.match(target.properties.permission.description, /read-only/u);
  assert.match(TASK_CENTER_TOOL.description, /`permission`/u);
});

test('tool: create stores the model and permission it was given', async () => {
  const harness = await withRuntime();
  try {
    const created = await TASK_CENTER_TOOL.execute({
      action: 'create',
      name: 'nightly',
      trigger: { kind: 'every', everySeconds: 3600 },
      target: {
        kind: 'newSession',
        workspaceId: 'ws-1',
        model: { provider: 'deepseek', model: 'deepseek-chat' },
        permission: 'read-only',
      },
      message: { text: 'run the checks' },
    }, exec());
    assert.equal(created.ok, true);
    const stored = harness.store.get(created.task.id);
    assert.deepEqual(stored.target.model, { provider: 'deepseek', model: 'deepseek-chat' });
    assert.equal(stored.target.permission, 'read-only');
    const listed = await TASK_CENTER_TOOL.execute({ action: 'list' }, exec());
    assert.match(JSON.stringify(listed), /using deepseek-chat \(read-only\)/u);
  } finally {
    await harness.cleanup();
  }
});
