import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDeliverer, DeliveryError, renderMessage } from '../lib/deliver.js';
import { normalizeDraft } from '../lib/model.js';
import { createScheduler, recomputeSchedule } from '../lib/scheduler.js';
import { createStore } from '../lib/store.js';

const BASE = Date.parse('2026-06-01T08:00:00Z');

/** One stored record. */
function makeTask(overrides = {}) {
  return normalizeDraft({
    name: 'job',
    trigger: { kind: 'every', everySeconds: 60, anchorAt: new Date(BASE).toISOString() },
    target: { kind: 'session', sessionId: 's-1' },
    message: { text: 'body' },
    ...overrides,
  }, { nowMs: BASE });
}

/** A store rooted in a disposable directory. */
async function makeStore() {
  const dir = await mkdtemp(join(tmpdir(), 'task-center-sched-'));
  const store = createStore({ dir });
  store.load();
  return store;
}

/** A deliverer stub that records calls. */
function stubDeliverer(behaviour = {}) {
  const calls = [];
  return {
    calls,
    async deliver(input) {
      calls.push({ taskId: input.task.id, payload: input.payload, text: input.task.message.text });
      if (behaviour.fail !== undefined) throw behaviour.fail;
      return { sessionId: behaviour.sessionId ?? 'sess-1' };
    },
  };
}

test('recomputeSchedule: statuses and next occurrence', () => {
  const task = makeTask();
  assert.equal(recomputeSchedule(task, BASE), true);
  assert.equal(task.state.status, 'active');
  assert.equal(task.state.nextAt, new Date(BASE + 60000).toISOString());

  task.enabled = false;
  assert.equal(recomputeSchedule(task, BASE), true);
  assert.equal(task.state.status, 'inactive');
  assert.equal(task.state.nextAt, undefined);

  const hook = makeTask({ trigger: { kind: 'webhook' } });
  assert.equal(recomputeSchedule(hook, BASE), false, 'a webhook task needs no schedule change');
  assert.equal(hook.state.status, 'active');
  assert.equal(hook.state.nextAt, undefined);
});

test('scheduler: downtime is recorded as one skipped run, never delivered late', async () => {
  const store = await makeStore();
  const deliverer = stubDeliverer();
  const task = makeTask({
    trigger: { kind: 'every', everySeconds: 3600, anchorAt: new Date(BASE).toISOString() },
  });
  task.state.evaluatedThrough = new Date(BASE).toISOString();
  await store.put(task);

  const clock = BASE + 3 * 3600000 + 60000;
  const scheduler = createScheduler({ store, deliverer, now: () => clock });
  await scheduler.start();
  await scheduler.stop();

  const stored = store.get(task.id);
  assert.equal(deliverer.calls.length, 0, 'nothing is delivered for a missed window');
  assert.equal(stored.history.length, 1);
  assert.equal(stored.history[0].result, 'missed');
  assert.equal(stored.history[0].code, 'skipped');
  assert.equal(stored.history[0].params.count, 3);
  assert.ok(Date.parse(stored.state.nextAt) > clock);
  await store.close();
});

test('scheduler: a due task fires once and advances', async () => {
  const store = await makeStore();
  const deliverer = stubDeliverer({ sessionId: 'sess-9' });
  let clock = BASE;
  const task = makeTask();
  task.state.nextAt = new Date(BASE).toISOString();
  task.state.evaluatedThrough = new Date(BASE).toISOString();
  await store.put(task);

  const scheduler = createScheduler({ store, deliverer, now: () => clock });
  await scheduler.tick();

  assert.equal(deliverer.calls.length, 1);
  const stored = store.get(task.id);
  assert.equal(stored.history.length, 1);
  assert.equal(stored.history[0].result, 'ok');
  assert.equal(stored.history[0].sessionId, 'sess-9');
  assert.equal(stored.state.consecutiveFailures, 0);
  assert.equal(stored.state.needsAttention, false);
  assert.equal(stored.state.nextAt, new Date(BASE + 60000).toISOString());

  // A second pass without advancing the clock must not fire again.
  await scheduler.tick();
  assert.equal(deliverer.calls.length, 1);
  clock = BASE + 60000;
  await scheduler.tick();
  assert.equal(deliverer.calls.length, 2);
  await scheduler.stop();
  await store.close();
});

test('scheduler: a failed delivery is recorded and the task keeps its schedule', async () => {
  const store = await makeStore();
  const deliverer = stubDeliverer({ fail: new DeliveryError('target-missing', 'session is gone') });
  const task = makeTask();
  task.state.nextAt = new Date(BASE).toISOString();
  await store.put(task);

  const scheduler = createScheduler({ store, deliverer, now: () => BASE });
  await scheduler.tick();
  await scheduler.stop();

  const stored = store.get(task.id);
  assert.equal(stored.history[0].result, 'failed');
  assert.match(stored.history[0].detail, /target-missing/u);
  assert.equal(stored.state.needsAttention, true);
  assert.equal(stored.enabled, true);
  assert.equal(stored.state.status, 'active');
  assert.ok(stored.state.nextAt);
  await store.close();
});

test('scheduler: a webhook run bypasses the clock', async () => {
  const store = await makeStore();
  const deliverer = stubDeliverer();
  const task = makeTask({ trigger: { kind: 'webhook' } });
  await store.put(task);
  const scheduler = createScheduler({ store, deliverer, now: () => BASE });

  const entry = await scheduler.runNow(task.id, { payload: 'from the web' });
  assert.equal(entry.result, 'ok');
  assert.equal(deliverer.calls[0].payload, 'from the web');
  const stored = store.get(task.id);
  assert.equal(stored.history.length, 1);
  assert.equal(stored.state.nextAt, undefined);
  assert.equal(await scheduler.runNow('task-missing', {}), undefined);
  await store.close();
});

test('scheduler: stop clears the pending timer and start is idempotent', async () => {
  const store = await makeStore();
  const deliverer = stubDeliverer();
  const task = makeTask();
  await store.put(task);
  const scheduler = createScheduler({ store, deliverer, now: () => BASE });
  await scheduler.start();
  await scheduler.stop();
  await scheduler.stop();
  assert.equal(store.get(task.id).state.status, 'active');
  await store.close();
});

test('renderMessage: the payload placeholder is always replaced', () => {
  assert.equal(renderMessage('start {{payload}} end', 'x'), 'start x end');
  assert.equal(renderMessage('start {{payload}} end', undefined), 'start  end');
  assert.equal(renderMessage('no placeholder', 'x'), 'no placeholder');
});

test('deliver: a message goes through prompt with a user source', async () => {
  const calls = [];
  const ctx = {
    sessionController: {
      async prompt(request) {
        calls.push(request);
        return { accepted: true };
      },
    },
    get: () => undefined,
  };
  const { deliver } = createDeliverer({ ctx });
  const task = makeTask({ message: { text: 'run /skill-a please' } });
  const result = await deliver({ task, signal: AbortSignal.timeout(1000) });
  assert.equal(result.sessionId, 's-1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionId, 's-1');
  assert.equal(calls[0].mode, 'queue');
  assert.deepEqual(calls[0].content, [{ type: 'text', text: 'run /skill-a please' }]);
  assert.match(calls[0].requestId, /^[0-9a-f-]{36}$/u);
});

test('deliver: a new-session target creates the session first', async () => {
  const created = [];
  const prompted = [];
  const ctx = {
    sessionController: {
      async create(request) {
        created.push(request);
        return { sessionId: 'fresh' };
      },
      async prompt(request) {
        prompted.push(request);
        return { accepted: true };
      },
    },
    get: () => undefined,
  };
  const { deliver } = createDeliverer({ ctx });
  const task = makeTask({ target: { kind: 'newSession', workspaceId: 'ws-1', agentPreset: 'standard' } });
  const result = await deliver({ task, signal: AbortSignal.timeout(1000) });
  assert.equal(result.sessionId, 'fresh');
  assert.deepEqual(created, [{ workspaceId: 'ws-1', agentPreset: 'standard' }]);
  assert.equal(prompted[0].sessionId, 'fresh');
});

test('deliver: goal mode runs the command instead of sending a message', async () => {
  const executed = [];
  const prompts = [];
  const ctx = {
    sessionController: {
      async prompt(request) {
        prompts.push(request);
        return { accepted: true };
      },
      async resolveAgent(sessionId) {
        return { agent: { session: { id: sessionId } } };
      },
    },
    get: (key) => (key === 'commands' ? { execute: async (...args) => executed.push(args) } : undefined),
  };
  const { deliver } = createDeliverer({ ctx });
  const task = makeTask({ message: { text: 'ship it', goalMode: true } });
  await deliver({ task, signal: AbortSignal.timeout(1000) });
  assert.equal(prompts.length, 0);
  assert.equal(executed.length, 1);
  assert.equal(executed[0][1], '/goal ship it');
  assert.deepEqual(executed[0][2], []);
});

test('deliver: goal mode without a command service fails loudly', async () => {
  const ctx = {
    sessionController: {
      async resolveAgent() {
        return { agent: {} };
      },
    },
    get: () => undefined,
  };
  const { deliver } = createDeliverer({ ctx });
  const task = makeTask({ message: { text: 'x', goalMode: true } });
  await assert.rejects(() => deliver({ task, signal: AbortSignal.timeout(1000) }), (error) => {
    assert.ok(error instanceof DeliveryError);
    assert.equal(error.code, 'commands-unavailable');
    return true;
  });
});

test('deliver: a vanished target session surfaces as target-missing', async () => {
  const ctx = {
    sessionController: {
      async resolveAgent() {
        return { error: { code: 'session/not-found', message: 'gone' } };
      },
    },
    get: (key) => (key === 'commands' ? { execute: async () => ({}) } : undefined),
  };
  const { deliver } = createDeliverer({ ctx });
  const task = makeTask({ message: { text: 'x', goalMode: true } });
  await assert.rejects(() => deliver({ task, signal: AbortSignal.timeout(1000) }), /cannot open session/u);
});
