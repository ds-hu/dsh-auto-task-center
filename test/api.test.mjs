import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApi } from '../lib/api.js';
import { createScheduler } from '../lib/scheduler.js';
import { createStore } from '../lib/store.js';

const BASE = Date.parse('2026-06-01T08:00:00Z');

/**
 * Boot the HTTP surface against stubs and hand back a client.
 * @returns {Promise<{ origin: string, call: Function, store: any, close: Function, sessions: string[] }>} the harness.
 */
async function boot() {
  const dir = await mkdtemp(join(tmpdir(), 'task-center-api-'));
  const store = createStore({ dir });
  store.load();
  const delivered = [];
  const deliverer = {
    async deliver({ task, payload }) {
      delivered.push({ taskId: task.id, payload });
      return { sessionId: 'sess-42' };
    },
  };
  const scheduler = createScheduler({ store, deliverer, now: () => BASE });
  const workspaceRegistry = {
    list: () => [{ id: 'ws-1', title: 'Demo', path: '/work/demo' }],
  };
  const ctx = {
    sessionController: {
      async list() {
        return {
          items: [
            { sessionId: 'sess-old', updatedAt: BASE - 7200000, running: false, blank: false, cwd: '/work/demo' },
            { sessionId: 'sess-new', updatedAt: BASE - 60000, running: true, blank: false, cwd: '/work/other' },
          ],
        };
      },
    },
    get: (key) => {
      if (key === 'agentPresets') {
        return {
          async list() {
            return [
              { id: 'standard', name: 'Standard', order: 1 },
              { id: 'task-center', name: '任务管理', order: 5 },
            ];
          },
        };
      }
      if (key === 'commands') return { execute: async () => ({}) };
      if (key === 'workspaceRegistry') return workspaceRegistry;
      return undefined;
    },
  };
  let origin = '';
  const api = createApi({
    store,
    scheduler,
    ctx,
    origin: () => origin,
    version: '0.1.0',
    now: () => BASE,
  });
  const server = http.createServer((req, res) => {
    void api.handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;

  /**
   * One request against the harness.
   * @param {string} path - Path below the origin.
   * @param {object} [options] - `method`, `body`, `headers`.
   * @returns {Promise<{ status: number, body: any }>} the response.
   */
  async function call(path, options = {}) {
    const init = { method: options.method ?? 'GET', headers: { ...(options.headers ?? {}) } };
    if (options.body !== undefined) {
      init.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
      if (init.headers['content-type'] === undefined) init.headers['content-type'] = 'application/json';
    }
    const response = await fetch(origin + path, init);
    let body = null;
    try {
      body = await response.json();
    } catch {
      /* not JSON */
    }
    return { status: response.status, body };
  }

  return {
    origin,
    call,
    store,
    delivered,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await scheduler.stop();
      await store.close();
    },
  };
}

/** A valid draft. */
function draft(overrides = {}) {
  return {
    name: 'nightly',
    trigger: { kind: 'daily', time: '09:00', timeZone: 'UTC' },
    target: { kind: 'newSession', workspaceId: 'ws-1', agentPreset: 'standard' },
    message: { text: 'please run the checks' },
    ...overrides,
  };
}

test('api: state hydrates the panel in one call', async () => {
  const harness = await boot();
  try {
    const { status, body } = await harness.call('/task-center/api/state');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.origin, harness.origin);
    assert.deepEqual(body.tasks, []);
    assert.deepEqual(body.workspaces, [{ id: 'ws-1', title: 'Demo', path: '/work/demo' }]);
    assert.deepEqual(body.presets.map((preset) => preset.id), ['standard', 'task-center']);
    assert.equal(body.capabilities.commands, true);
    assert.equal(body.capabilities.sessions, true);
  } finally {
    await harness.close();
  }
});

test('api: mutations require JSON and the Host origin', async () => {
  const harness = await boot();
  try {
    const noType = await harness.call('/task-center/api/tasks', {
      method: 'POST',
      body: JSON.stringify(draft()),
      headers: { 'content-type': 'text/plain' },
    });
    assert.equal(noType.status, 415);
    assert.equal(noType.body.code, 'unsupported-media-type');

    const foreign = await harness.call('/task-center/api/tasks', {
      method: 'POST',
      body: draft(),
      headers: { origin: 'https://evil.example' },
    });
    assert.equal(foreign.status, 403);
    assert.equal(foreign.body.code, 'cross-origin');

    const sameOrigin = await harness.call('/task-center/api/tasks', {
      method: 'POST',
      body: draft(),
      headers: { origin: harness.origin },
    });
    assert.equal(sameOrigin.status, 200);
  } finally {
    await harness.close();
  }
});

test('api: create, update, conflict and delete', async () => {
  const harness = await boot();
  try {
    const created = await harness.call('/task-center/api/tasks', { method: 'POST', body: draft() });
    assert.equal(created.status, 200);
    assert.equal(created.body.task.name, 'nightly');
    assert.ok(created.body.task.state.nextAt);
    const id = created.body.task.id;

    const conflict = await harness.call(`/task-center/api/tasks/${id}`, {
      method: 'POST',
      body: { task: draft({ name: 'renamed' }), expectedUpdatedAt: '1999-01-01T00:00:00.000Z' },
    });
    assert.equal(conflict.status, 409);

    const updated = await harness.call(`/task-center/api/tasks/${id}`, {
      method: 'POST',
      body: { task: draft({ name: 'renamed' }), expectedUpdatedAt: created.body.task.updatedAt },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.task.name, 'renamed');
    assert.equal(updated.body.task.id, id);

    const invalid = await harness.call(`/task-center/api/tasks/${id}`, {
      method: 'POST',
      body: { task: draft({ trigger: { kind: 'every', everySeconds: 5 } }) },
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.code, 'trigger/every-invalid');

    const removed = await harness.call(`/task-center/api/tasks/${id}/delete`, { method: 'POST', body: {} });
    assert.equal(removed.status, 200);
    const state = await harness.call('/task-center/api/state');
    assert.deepEqual(state.body.tasks, []);
  } finally {
    await harness.close();
  }
});

test('api: the session picker sorts by recency and filters', async () => {
  const harness = await boot();
  try {
    const all = await harness.call('/task-center/api/sessions');
    assert.equal(all.status, 200);
    assert.deepEqual(all.body.items.map((row) => row.sessionId), ['sess-new', 'sess-old']);
    const filtered = await harness.call('/task-center/api/sessions?q=other');
    assert.deepEqual(filtered.body.items.map((row) => row.sessionId), ['sess-new']);
    const none = await harness.call('/task-center/api/sessions?q=nothing');
    assert.deepEqual(none.body.items, []);
  } finally {
    await harness.close();
  }
});

test('api: the preview answers with the next runs', async () => {
  const harness = await boot();
  try {
    const { status, body } = await harness.call('/task-center/api/preview', {
      method: 'POST',
      body: { trigger: { kind: 'cron', expression: '0 9 * * *', timeZone: 'UTC' } },
    });
    assert.equal(status, 200);
    assert.equal(body.next.length, 5);
    assert.equal(body.next[0], '2026-06-01T09:00:00.000Z');
    const bad = await harness.call('/task-center/api/preview', {
      method: 'POST',
      body: { trigger: { kind: 'cron', expression: 'nope', timeZone: 'UTC' } },
    });
    assert.equal(bad.status, 400);
  } finally {
    await harness.close();
  }
});

test('api: a webhook fires the task, guards the secret and rotates', async () => {
  const harness = await boot();
  try {
    const created = await harness.call('/task-center/api/tasks', {
      method: 'POST',
      body: draft({ trigger: { kind: 'webhook' }, message: { text: 'payload was {{payload}}' } }),
    });
    const id = created.body.task.id;
    const secret = created.body.task.trigger.secret;

    assert.equal((await harness.call(`/task-center/hook/${id}/wrong`)).status, 403);
    assert.equal((await harness.call('/task-center/hook/task-nope/abc')).status, 404);

    const fired = await harness.call(`/task-center/hook/${id}/${secret}`, { method: 'POST', body: 'hello', headers: { 'content-type': 'text/plain' } });
    assert.equal(fired.status, 200);
    assert.equal(fired.body.ok, true);
    assert.ok(fired.body.runId);
    assert.equal(harness.delivered.length, 1);
    assert.equal(harness.delivered[0].payload, 'hello');

    const rotated = await harness.call(`/task-center/api/tasks/${id}/rotate-secret`, { method: 'POST', body: {} });
    assert.equal(rotated.status, 200);
    assert.notEqual(rotated.body.task.trigger.secret, secret);
    assert.equal((await harness.call(`/task-center/hook/${id}/${secret}`)).status, 403);
    assert.equal((await harness.call(`/task-center/hook/${id}/${rotated.body.task.trigger.secret}`)).status, 200);

    const disabled = await harness.call(`/task-center/api/tasks/${id}`, {
      method: 'POST',
      body: { task: { ...draft({ trigger: { kind: 'webhook', secret: rotated.body.task.trigger.secret } }), enabled: false } },
    });
    assert.equal(disabled.status, 200);
    assert.equal((await harness.call(`/task-center/hook/${id}/${rotated.body.task.trigger.secret}`)).status, 409);
  } finally {
    await harness.close();
  }
});

test('api: webhook calls are rate limited per task', async () => {
  const harness = await boot();
  try {
    const created = await harness.call('/task-center/api/tasks', { method: 'POST', body: draft({ trigger: { kind: 'webhook' } }) });
    const id = created.body.task.id;
    const secret = created.body.task.trigger.secret;
    let limited = 0;
    for (let index = 0; index < 61; index += 1) {
      const result = await harness.call(`/task-center/hook/${id}/${secret}`);
      if (result.status === 429) limited += 1;
    }
    assert.equal(limited, 1, 'the 61st call in the same minute is refused');
  } finally {
    await harness.close();
  }
});

test('api: history can be cleared and unknown routes answer 404', async () => {
  const harness = await boot();
  try {
    const created = await harness.call('/task-center/api/tasks', { method: 'POST', body: draft({ trigger: { kind: 'webhook' } }) });
    const id = created.body.task.id;
    await harness.call(`/task-center/hook/${id}/${created.body.task.trigger.secret}`);
    const before = await harness.call('/task-center/api/state');
    assert.equal(before.body.tasks[0].history.length, 1);
    const cleared = await harness.call(`/task-center/api/tasks/${id}/clear-history`, { method: 'POST', body: {} });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.task.history.length, 0);

    assert.equal((await harness.call('/task-center/api/nope')).status, 404);
    assert.equal((await harness.call('/task-center/hook')).status, 404);
    assert.equal((await harness.call('/task-center/api/tasks', { method: 'GET' })).status, 405);
  } finally {
    await harness.close();
  }
});

test('api: a webhook task is the only kind that can rotate a secret', async () => {
  const harness = await boot();
  try {
    const created = await harness.call('/task-center/api/tasks', { method: 'POST', body: draft() });
    const id = created.body.task.id;
    const result = await harness.call(`/task-center/api/tasks/${id}/rotate-secret`, { method: 'POST', body: {} });
    assert.equal(result.status, 400);
    assert.equal(result.body.code, 'not-a-webhook');
  } finally {
    await harness.close();
  }
});
