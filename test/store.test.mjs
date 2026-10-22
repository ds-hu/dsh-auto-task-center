import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createStore, resolveDataDir, STORE_FILE } from '../lib/store.js';
import { appendHistory, normalizeDraft } from '../lib/model.js';

/** A disposable data directory. */
async function tempDir() {
  return mkdtemp(join(tmpdir(), 'task-center-store-'));
}

/** One valid record. */
function draft(name = 'task') {
  return normalizeDraft({
    name,
    trigger: { kind: 'daily', time: '09:00', timeZone: 'UTC' },
    target: { kind: 'session', sessionId: 's-1' },
    message: { text: 'body' },
  }, { nowMs: Date.parse('2026-06-01T00:00:00Z') });
}

test('store: nothing is written before the first task exists', async () => {
  const dir = await tempDir();
  const store = createStore({ dir });
  store.load();
  assert.equal(store.size, 0);
  assert.equal(existsSync(dir), true, 'mkdtemp created the directory itself');
  const fresh = join(await tempDir(), 'nested');
  const lazy = createStore({ dir: fresh });
  lazy.load();
  await lazy.close();
  assert.equal(existsSync(fresh), false, 'a load must not create the data directory');
});

test('store: put, list, get, update and remove survive a reload', async () => {
  const dir = await tempDir();
  const store = createStore({ dir });
  store.load();
  const task = draft('one');
  await store.put(task);
  assert.equal(store.size, 1);
  assert.deepEqual(store.get(task.id), task);
  assert.equal(store.list().length, 1);
  await store.update(task.id, (copy) => {
    copy.name = 'renamed';
  });
  assert.equal(store.get(task.id).name, 'renamed');
  await store.close();

  const reopened = createStore({ dir });
  const summary = reopened.load();
  assert.equal(summary.loaded, 1);
  assert.equal(reopened.get(task.id).name, 'renamed');
  await reopened.close();
});

test('store: the write is atomic and leaves no temporary file behind', async () => {
  const dir = await tempDir();
  const store = createStore({ dir });
  store.load();
  const task = draft('atomic');
  await store.put(task);
  const files = await readdir(dir);
  assert.deepEqual(files, [STORE_FILE]);
  const raw = JSON.parse(await readFile(join(dir, STORE_FILE), 'utf8'));
  assert.equal(raw.version, 1);
  assert.equal(Object.keys(raw.tasks).length, 1);
  await store.close();
});

test('store: a damaged file is quarantined instead of failing the load', async () => {
  const dir = await tempDir();
  await writeFile(join(dir, STORE_FILE), '{ not json', 'utf8');
  const warnings = [];
  const store = createStore({ dir, logger: (level, message) => warnings.push([level, message]) });
  const summary = store.load();
  assert.equal(summary.loaded, 0);
  assert.ok(summary.quarantined);
  assert.equal(existsSync(summary.quarantined), true);
  assert.equal(existsSync(join(dir, STORE_FILE)), false);
  assert.ok(warnings.some(([level]) => level === 'error'));
  await store.close();
});

test('store: one damaged record is dropped, the rest load', async () => {
  const dir = await tempDir();
  const good = draft('good');
  const bad = { ...draft('bad'), trigger: { kind: 'daily', time: '99:99', timeZone: 'UTC' } };
  await writeFile(join(dir, STORE_FILE), JSON.stringify({ version: 1, tasks: [good, bad] }), 'utf8');
  const store = createStore({ dir });
  const summary = store.load();
  assert.equal(summary.loaded, 1);
  assert.equal(summary.dropped, 1);
  assert.equal(store.get(good.id).name, 'good');
  await store.close();
});

test('store: a newer document version is read with a warning', async () => {
  const dir = await tempDir();
  const task = draft('future');
  await writeFile(join(dir, STORE_FILE), JSON.stringify({ version: 99, tasks: [task] }), 'utf8');
  const warnings = [];
  const store = createStore({ dir, logger: (level, message) => warnings.push([level, message]) });
  const summary = store.load();
  assert.equal(summary.loaded, 1);
  assert.ok(warnings.some(([level, message]) => level === 'warn' && message.includes('version')));
  await store.close();
});

test('store: history is capped and listeners fire once per change', async () => {
  const dir = await tempDir();
  const store = createStore({ dir });
  store.load();
  let changes = 0;
  const unsubscribe = store.onChange(() => {
    changes += 1;
  });
  const task = draft('noisy');
  for (let index = 0; index < 60; index += 1) {
    appendHistory(task, { at: new Date(Date.parse('2026-06-01T00:00:00Z') + index * 1000).toISOString(), result: 'ok', detail: `run ${index}` });
  }
  assert.equal(task.history.length, 50);
  await store.put(task);
  assert.equal(changes, 1);
  unsubscribe();
  await store.update(task.id, (copy) => {
    copy.name = 'quiet';
  });
  assert.equal(changes, 1, 'the listener was removed');
  await store.close();
});

test('store: close waits for queued writes and refuses new ones', async () => {
  const dir = await tempDir();
  const store = createStore({ dir });
  store.load();
  const task = draft('draining');
  store.put(task);
  await store.close();
  const raw = JSON.parse(await readFile(join(dir, STORE_FILE), 'utf8'));
  assert.equal(Object.keys(raw.tasks).length, 1);
  await assert.rejects(() => store.put(task), /closed/u);
});

test('store: the data directory is $DSH_HOME/task-center', () => {
  assert.equal(resolveDataDir({ DSH_HOME: '/srv/dsh' }), '/srv/dsh/task-center');
  assert.equal(resolveDataDir({ HOME: '/home/me' }), '/home/me/.dsh/task-center');
  assert.equal(resolveDataDir({ DSH_HOME: '/srv/dsh', HOME: '/home/me' }), '/srv/dsh/task-center');
});

test('store: a write failure is reported to the caller, not swallowed', async () => {
  const dir = await tempDir();
  const store = createStore({ dir });
  store.load();
  // A file where the directory should be makes mkdir fail.
  const blocked = join(dir, 'blocker');
  await writeFile(blocked, 'x', 'utf8');
  const broken = createStore({ dir: join(blocked, 'inside') });
  broken.load();
  await assert.rejects(() => broken.put(draft('nope')));
  await store.close();
});
