#!/usr/bin/env node
/**
 * End-to-end check for worktree targets, run by hand against a live instance.
 *
 * It is deliberately not part of `npm test`: it needs a running DSH whose profile
 * mounts both this plugin and `dsh-better-workspaces`, plus a registered git
 * workspace to create worktrees in. `docs/TECHNICAL.md#testing` describes the
 * harness.
 *
 * Usage:
 *   node test/e2e/worktree.mjs --origin http://127.0.0.1:3080 --repo /path/to/git/repo
 *
 * The script creates one webhook task, fires it twice, and asserts that the two
 * runs produced two distinct worktrees, that each session's cwd is inside its
 * own worktree, and that the history names the branch. It leaves the task and
 * the worktrees behind — cleaning up is the other plugin's job, and that is the
 * behaviour being verified.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

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
  process.stderr.write('usage: node test/e2e/worktree.mjs --origin <url> [--repo <path>]\n');
  process.exit(2);
}

/** One JSON call against the panel API. */
async function call(path, { method = 'GET', body } = {}) {
  const response = await fetch(origin + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

const state = async () => (await call('/task-center/api/state')).body;

const before = await state();
assert.equal(before.capabilities.worktrees, true, 'dsh-better-workspaces must be mounted for this check');
const workspace = options.repo === undefined
  ? before.workspaces.find((row) => row.path !== undefined)
  : before.workspaces.find((row) => row.path === options.repo);
assert.ok(workspace, `no registered workspace for ${options.repo ?? 'any path'}`);
process.stdout.write(`workspace: ${workspace.title} → ${workspace.path}\n`);

const created = await call('/task-center/api/tasks', {
  method: 'POST',
  body: {
    name: `worktree e2e ${Date.now()}`,
    trigger: { kind: 'webhook' },
    target: { kind: 'newSession', workspaceId: workspace.id, worktree: {} },
    message: { text: 'Reply with the output of `pwd` and `git rev-parse --abbrev-ref HEAD`. Do not change any file.' },
  },
});
assert.equal(created.status, 200, JSON.stringify(created.body));
const task = created.body.task;
process.stdout.write(`task: ${task.id} (${task.targetSummary})\n`);

/**
 * Fire the webhook once and wait for the matching run record.
 * @param {string} label - Payload marker, for the log.
 * @param {number} expected - How many records the task must end up with.
 * @returns {Promise<Record<string, any>>} the task row.
 */
async function fire(label, expected) {
  const response = await fetch(`${origin}/task-center/hook/${task.id}/${task.trigger.secret}`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: `e2e ${label}`,
  });
  assert.equal(response.status, 200, `webhook answered ${response.status}`);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const row = (await state()).tasks.find((item) => item.id === task.id);
    if (row.history.length >= expected) return row;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error(`run ${label} never appeared in the history`);
}

await fire('one', 1);
const second = await fire('two', 2);
const [newer, older] = second.history;
assert.equal(newer.code, 'delivered');
assert.equal(older.code, 'delivered');
assert.notEqual(newer.params.worktree.path, older.params.worktree.path, 'each run needs its own worktree');
assert.notEqual(newer.params.worktree.branch, older.params.worktree.branch, 'each run needs its own branch');
assert.notEqual(newer.sessionId, older.sessionId, 'each run needs its own session');

for (const entry of [newer, older]) {
  const head = execFileSync('git', ['-C', entry.params.worktree.path, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.equal(head, entry.params.worktree.branch, `git head of ${entry.params.worktree.path}`);
  process.stdout.write(`run ${entry.runId}: ${entry.params.worktree.branch} → ${entry.params.worktree.path} (${entry.sessionId})\n`);
}

const sessions = (await call('/task-center/api/sessions')).body.items;
for (const entry of [newer, older]) {
  const session = sessions.find((row) => row.sessionId === entry.sessionId);
  assert.ok(session, `session ${entry.sessionId} is missing`);
  assert.equal(session.cwd, entry.params.worktree.path, 'the session must run inside its worktree');
  process.stdout.write(`session ${session.sessionId}: cwd ${session.cwd}\n`);
}

const listed = execFileSync('git', ['-C', older.params.worktree.path, 'worktree', 'list'], { encoding: 'utf8' });
assert.ok(listed.includes(newer.params.worktree.path), 'the second worktree is not in git worktree list');
process.stdout.write('worktree e2e: both runs created their own worktree\n');
