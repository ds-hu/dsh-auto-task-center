#!/usr/bin/env node
/**
 * End-to-end check for model and permission targets, run by hand against a live
 * instance.
 *
 * It is deliberately not part of `npm test`: it needs a running DSH whose
 * profile offers at least one routable model and the official permission
 * presets, plus a registered workspace. `docs/TECHNICAL.md#testing` describes
 * the harness.
 *
 * Usage:
 *   node test/e2e/model-permission.mjs --origin http://127.0.0.1:3080 \
 *     --home /tmp/tc-e2e/home
 *
 * `--home` is the isolated `DSH_HOME` the instance runs on; the script reads the
 * session log under `sessions/` to prove the durable `model/selection` and
 * `permission/preset` events, which the panel API never returns. It creates
 * three tasks and fires each once: the two that cannot work must fail with
 * `model-unavailable` and `permission-invalid` instead of half-delivering.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { globSync } from 'node:fs';

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
const origin = (options.origin ?? '').replace(/\/+$/u, '');
if (origin === '') {
  console.error('usage: node test/e2e/model-permission.mjs --origin http://127.0.0.1:3080 [--home /tmp/tc-e2e/home]');
  process.exit(2);
}
const home = options.home ?? '';

/**
 * One API call against the panel surface.
 * @param {string} path - Absolute path under the origin.
 * @param {RequestInit} [init] - Request options.
 * @returns {Promise<{ status: number, body: any }>} the decoded answer.
 */
async function call(path, init) {
  const response = await fetch(`${origin}${path}`, init);
  return { status: response.status, body: await response.json() };
}

/**
 * Read every event of one session log, newest file first.
 * @param {string} sessionId - Session identity.
 * @returns {Promise<string>} the decompressed transcript.
 */
async function sessionTranscript(sessionId) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const file = globSync(`${home}/sessions/**/session.v4.jsonl.zstd`).find((candidate) => candidate.includes(sessionId));
    if (file !== undefined) return execFileSync('zstd', ['-dc', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`no session log for ${sessionId} under ${home}/sessions`);
}

const state = (await call('/task-center/api/state')).body;
assert.equal(state.ok, true, 'the panel API must answer');
assert.equal(state.capabilities.models, true, 'this profile must advertise a model catalog');
assert.equal(state.capabilities.permissions, true, 'this profile must advertise permission presets');
const workspace = state.workspaces[0];
assert.notEqual(workspace, undefined, 'this profile needs one registered workspace');

const model = state.models.options.find((entry) => entry.model !== state.models.default.model) ?? state.models.options[0];
const permission = state.permissions.options.find((option) => option.value === 'read-only') ?? state.permissions.options[0];
// Pick an effort the model actually declares, preferring one that is not the default.
const effort = Array.isArray(model.efforts) && model.efforts.length > 0
  ? (model.efforts.find((row) => row.id !== model.defaultEffort) ?? model.efforts[0]).id
  : '';
console.log(`workspace=${workspace.title} model=${model.provider}/${model.model} permission=${permission.value}${effort === '' ? '' : ` effort=${effort}`}`);

/**
 * Create one webhook task and fire it.
 * @param {Record<string, any>} target - The delivery target.
 * @returns {Promise<{ created: any, fired: any }>} the task and the run answer.
 */
async function createAndFire(target) {
  const created = await call('/task-center/api/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: `e2e ${Math.random().toString(16).slice(2, 8)}`,
      trigger: { kind: 'webhook' },
      target,
      message: { text: 'Summarize the open work in this repository.' },
    }),
  });
  assert.equal(created.status, 200, `create failed: ${JSON.stringify(created.body)}`);
  const task = created.body.task;
  const fired = await call(`/task-center/hook/${task.id}/${task.trigger.secret}`, { method: 'POST' });
  // The hook answers with the run's verdict; the record itself lives in the list.
  const state = (await call('/task-center/api/state')).body;
  const entry = state.tasks.find((row) => row.id === task.id)?.history?.[0];
  return { created: task, fired, entry };
}

const happy = await createAndFire({
  kind: 'newSession',
  workspaceId: workspace.id,
  agentPreset: 'standard',
  model: { provider: model.provider, model: model.model, ...(effort === '' ? {} : { reasoningEffort: effort }) },
  permission: permission.value,
});
assert.equal(happy.fired.status, 200, `delivery failed: ${JSON.stringify(happy.fired.body)}`);
const entry = happy.entry;
assert.equal(entry.result, 'ok', `run failed: ${entry.code} ${entry.detail}`);
assert.equal(entry.params.model, `${model.provider}/${model.model}`, 'the record must name the model');
assert.equal(entry.params.permission, permission.value, 'the record must name the permission');
if (effort !== '') {
  assert.equal(entry.params.effort, effort, 'the record must name the reasoning effort');
  assert.match(entry.detail, new RegExp(`at ${effort} effort`, 'u'), 'the detail must say which effort ran');
}
console.log('record:', entry.detail);

if (home !== '') {
  const transcript = await sessionTranscript(entry.params.sessionId);
  assert.match(transcript, /"model\/selection"/u, 'the session log must record the model selection');
  assert.match(transcript, new RegExp(`"preset":"${permission.value}"`, 'u'), 'the session log must record the preset');
  if (effort !== '') {
    assert.match(transcript, new RegExp(`"reasoningEffort":"${effort}"`, 'u'), 'the session log must record the effort');
  }
  console.log('session log carries model/selection, reasoningEffort and permission/preset');
}

const badPreset = await createAndFire({ kind: 'newSession', workspaceId: workspace.id, permission: 'no-such-preset' });
assert.equal(badPreset.fired.status, 500, 'an unknown preset must fail the run');
assert.equal(badPreset.fired.body.result, 'failed');
assert.match(String(badPreset.fired.body.error), /^permission-invalid: /u);
console.log('unknown preset:', badPreset.fired.body.error);

const badModel = await createAndFire({ kind: 'newSession', workspaceId: workspace.id, model: { provider: 'nowhere', model: 'ghost' } });
assert.equal(badModel.fired.status, 500, 'an unroutable model must fail the run');
assert.match(String(badModel.fired.body.error), /^model-unavailable: /u);
console.log('unknown model:', badModel.fired.body.error);

const sessionTarget = await call('/task-center/api/tasks', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    name: 'e2e session target',
    trigger: { kind: 'webhook' },
    target: { kind: 'session', sessionId: 'session-1', permission: 'read-only' },
    message: { text: 'x' },
  }),
});
assert.equal(sessionTarget.status, 400, 'an existing session must not be reconfigured');
assert.equal(sessionTarget.body.code, 'target/model-session');
console.log('session target rejected:', sessionTarget.body.error);

console.log('E2E OK');
