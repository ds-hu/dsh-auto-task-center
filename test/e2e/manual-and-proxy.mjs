#!/usr/bin/env node
/**
 * End-to-end check for the event model: a manual task, and a panel behind a proxy.
 *
 * Both halves of this script exist because of a real deployment. A user installed
 * the plugin on a VPS, reached the panel through Cloudflare, and found that
 * editing a task's message did nothing: every mutating request was answered with
 * `403 cross-origin`, because the fence compared the browser's `Origin` with the
 * loopback address the Host bound instead of the `Host` the browser used. A
 * manual trigger is the other half — a task that runs only when asked, which is
 * what the panel's Run now button and the tool's `run` action dispatch.
 *
 * Like the other scripts in this directory it is run by hand against a live
 * instance and is not part of `npm test`:
 *
 *   node test/e2e/manual-and-proxy.mjs \
 *     --origin http://127.0.0.1:3080 --proxy http://127.0.0.1:4173
 *
 * `--origin` is the address the Host bound; `--proxy` is the same instance seen
 * through `test/e2e/proxy.mjs`. Every request below goes through the proxy,
 * because that is the shape that used to fail.
 */
import assert from 'node:assert/strict';

/**
 * Read `--name value` pairs.
 * @param {string[]} argv - Process arguments.
 * @returns {Record<string, string>} the parsed flags.
 */
function flags(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    out[token.slice(2)] = argv[index + 1];
    index += 1;
  }
  return out;
}

const options = flags(process.argv.slice(2));
const proxy = (options.proxy ?? '').replace(/\/+$/u, '');
const direct = (options.origin ?? '').replace(/\/+$/u, '');
if (proxy === '') {
  console.error('usage: node test/e2e/manual-and-proxy.mjs --origin http://127.0.0.1:3080 --proxy http://127.0.0.1:4173');
  process.exit(2);
}
const workspaceId = options.workspace ?? '';
const preset = options.preset ?? 'standard';

/**
 * One request, with the `Origin` a browser would send.
 * @param {string} base - Origin to call.
 * @param {string} path - Path below it.
 * @param {RequestInit} [init] - Extra request options.
 * @returns {Promise<{ status: number, body: any }>} the decoded answer.
 */
async function call(base, path, init = {}) {
  const headers = { origin: base, 'content-type': 'application/json', ...(init.headers ?? {}) };
  const response = await fetch(`${base}${path}`, { ...init, headers });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

/** A task body aimed at a fresh session in the given workspace. */
function draft(name, trigger, extra = {}) {
  return {
    name,
    enabled: true,
    trigger,
    target: { kind: 'newSession', ...(workspaceId === '' ? {} : { workspaceId }), agentPreset: preset },
    message: { text: 'e2e body' },
    ...extra,
  };
}

/**
 * Report one passing step, so a run reads as a checklist.
 * @param {string} text - What just passed.
 * @returns {void}
 */
function ok(text) {
  console.log(`ok  ${text}`);
}

/* ------------------------------------------------------------------ */
/* 1. the fence accepts the origin a proxy deployment actually uses    */
/* ------------------------------------------------------------------ */

const proxied = await call(proxy, '/task-center/api/tasks', { method: 'POST', body: JSON.stringify(draft('proxy check', { kind: 'manual' })) });
if (proxied.status !== 200) {
  console.error(`the panel is unreachable behind the proxy: ${proxied.status} ${JSON.stringify(proxied.body)}`);
  process.exit(1);
}
const manualId = proxied.body.task.id;
assert.equal(proxied.body.task.trigger.kind, 'manual');
assert.equal(proxied.body.task.state.nextAt, undefined);
ok(`created a manual task through the proxy (${manualId})`);

if (direct !== '') {
  const crossSite = await call(direct, '/task-center/api/tasks', {
    method: 'POST',
    body: JSON.stringify(draft('cross site', { kind: 'manual' })),
    headers: { origin: 'https://evil.example' },
  });
  assert.equal(crossSite.status, 403, 'a page on another site is still refused');
  assert.equal(crossSite.body.code, 'cross-origin');
  ok('a foreign origin is still refused with cross-origin');
}

/* ------------------------------------------------------------------ */
/* 2. the message of an existing task can be edited                    */
/* ------------------------------------------------------------------ */

const before = (await call(proxy, '/task-center/api/state')).body.tasks.find((task) => task.id === manualId);
const edited = 'edited through the proxy';
const saved = await call(proxy, `/task-center/api/tasks/${manualId}`, {
  method: 'POST',
  body: JSON.stringify({ task: { ...before, message: { ...before.message, text: edited } }, expectedUpdatedAt: before.updatedAt }),
});
assert.equal(saved.status, 200, JSON.stringify(saved.body));
assert.equal(saved.body.task.message.text, edited);

const after = (await call(proxy, '/task-center/api/state')).body.tasks.find((task) => task.id === manualId);
assert.equal(after.message.text, edited, 'the edit survives a reload');
ok('an edited message is stored, not just echoed');

/* ------------------------------------------------------------------ */
/* 3. Run now dispatches a manual event and records its source         */
/* ------------------------------------------------------------------ */

const ran = await call(proxy, `/task-center/api/tasks/${manualId}/run`, { method: 'POST', body: '{}' });
assert.equal(ran.status, 200, JSON.stringify(ran.body));
assert.equal(ran.body.entry.source, 'manual');
assert.equal(ran.body.entry.result, 'ok');
assert.equal(ran.body.entry.code, 'delivered');
assert.equal(typeof ran.body.entry.sessionId, 'string');

const reloaded = (await call(proxy, '/task-center/api/state')).body.tasks.find((task) => task.id === manualId);
assert.equal(reloaded.history.length, 1);
assert.equal(reloaded.history[0].source, 'manual');
assert.equal(reloaded.state.nextAt, undefined, 'a manual run schedules nothing');
ok(`Run now delivered into session ${ran.body.entry.sessionId} and recorded source "manual"`);

/* ------------------------------------------------------------------ */
/* 4. a manual task never fires on the clock                           */
/* ------------------------------------------------------------------ */

const timer = await new Promise((resolve) => setTimeout(resolve, 1500));
const idle = (await call(proxy, '/task-center/api/state')).body.tasks.find((task) => task.id === manualId);
assert.equal(idle.history.length, 1, `the timer fired a manual task (waited ${timer} ms)`);
ok('the scheduler leaves a manual task alone');

/* ------------------------------------------------------------------ */
/* 5. clean up, leaving the instance as it was found                   */
/* ------------------------------------------------------------------ */

await call(proxy, `/task-center/api/tasks/${manualId}/delete`, { method: 'POST', body: '{}' });
const gone = (await call(proxy, '/task-center/api/state')).body.tasks.some((task) => task.id === manualId);
assert.equal(gone, false);
ok('the scratch task is gone');

console.log('\nmanual-and-proxy: all checks passed');
