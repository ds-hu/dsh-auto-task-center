import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createWorktreeClient, slugForTaskName } from '../lib/worktree.js';

const BASE = Date.parse('2026-06-01T08:00:00Z');

/**
 * Boot a stand-in for `dsh-better-workspaces` and a client pointed at it.
 *
 * @param {object} [options] - Harness options.
 * @param {(request: { method: string, path: string, headers: Record<string, any>, body: any }) => { status: number, payload: any }} [options.reply] - Answer factory.
 * @param {() => number} [options.now] - Clock for the cache.
 * @returns {Promise<{ client: ReturnType<typeof createWorktreeClient>, seen: any[], origin: string, close: () => Promise<void> }>} the harness.
 */
async function boot({ reply, now = () => BASE } = {}) {
  const seen = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw === '' ? null : JSON.parse(raw);
      const record = { method: request.method, path: request.url, headers: request.headers, body };
      seen.push(record);
      const answer = reply === undefined
        ? { status: 200, payload: { ok: true, items: [] } }
        : reply(record);
      response.writeHead(answer.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(answer.payload));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const client = createWorktreeClient({ origin: () => origin, now });
  return {
    client,
    seen,
    origin,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('worktree: the probe reports presence from the listing route', async () => {
  const harness = await boot({
    reply: (request) => (request.path.startsWith('/better-workspaces/api/worktree-workspaces')
      ? { status: 200, payload: { ok: true, items: [] } }
      : { status: 404, payload: { ok: false, error: 'not found' } }),
  });
  try {
    assert.deepEqual(await harness.client.probe(), { present: true });
  } finally {
    await harness.close();
  }
});

test('worktree: an unmounted plugin is absence, not an error', async () => {
  const harness = await boot({ reply: () => ({ status: 404, payload: { ok: false, error: 'not found' } }) });
  try {
    const answer = await harness.client.probe();
    assert.equal(answer.present, false);
    assert.match(String(answer.reason), /status 404/u);
  } finally {
    await harness.close();
  }
});

test('worktree: a closed port is absence too', async () => {
  const harness = await boot();
  await harness.close();
  const client = createWorktreeClient({ origin: () => harness.origin, now: () => BASE });
  const answer = await client.probe();
  assert.equal(answer.present, false);
  assert.equal(typeof answer.reason, 'string');
});

test('worktree: the probe answer is reused until it ages out', async () => {
  let clock = BASE;
  const harness = await boot({
    reply: () => ({ status: 200, payload: { ok: true, items: [] } }),
    now: () => clock,
  });
  try {
    await harness.client.probe();
    await harness.client.probe();
    assert.equal(harness.seen.length, 1, 'the second probe must not ask again');
    clock = BASE + 6 * 60_000;
    await harness.client.probe();
    assert.equal(harness.seen.length, 2, 'an aged probe asks again');
  } finally {
    await harness.close();
  }
});

test('worktree: branch options come from detect and branches', async () => {
  const harness = await boot({
    reply: (request) => {
      if (request.path.startsWith('/better-workspaces/api/detect')) {
        return { status: 200, payload: { ok: true, isGit: true, defaultBranch: 'main' } };
      }
      if (request.path.startsWith('/better-workspaces/api/branches')) {
        return { status: 200, payload: { ok: true, isGit: true, defaultBranch: 'main', branches: ['main', 'release/3.2'] } };
      }
      return { status: 404, payload: { ok: false } };
    },
  });
  try {
    const options = await harness.client.options({ repoPath: '/repo/one' });
    assert.deepEqual(options, { ok: true, isGit: true, defaultBranch: 'main', branches: ['main', 'release/3.2'] });
    assert.match(harness.seen[0].path, /\/detect\?path=%2Frepo%2Fone$/u);
  } finally {
    await harness.close();
  }
});

test('worktree: a non-git workspace is reported, not thrown', async () => {
  const harness = await boot({ reply: () => ({ status: 200, payload: { ok: true, isGit: false } }) });
  try {
    const options = await harness.client.options({ repoPath: '/notes' });
    assert.deepEqual(options, { ok: true, isGit: false, defaultBranch: null, branches: [] });
  } finally {
    await harness.close();
  }
});

test('worktree: create asks for a branch-off with the Host origin', async () => {
  const harness = await boot({
    reply: () => ({ status: 201, payload: { ok: true, path: '/repo/.worktrees/nightly', branch: 'nightly-2', workspaceId: 'ws-new' } }),
  });
  try {
    const created = await harness.client.create({ repoPath: '/repo', base: 'main', slug: 'nightly' });
    assert.deepEqual(created, { path: '/repo/.worktrees/nightly', branch: 'nightly-2', workspaceId: 'ws-new' });
    const sent = harness.seen[0];
    assert.equal(sent.method, 'POST');
    assert.equal(sent.path, '/better-workspaces/api/worktrees');
    assert.equal(sent.headers['content-type'], 'application/json');
    assert.equal(sent.headers.origin, harness.origin);
    assert.deepEqual(sent.body, { cwd: '/repo', intent: 'branch-off', base: 'main', slug: 'nightly' });
  } finally {
    await harness.close();
  }
});

test('worktree: create omits an empty base and slug', async () => {
  const harness = await boot({ reply: () => ({ status: 201, payload: { ok: true, path: '/repo/wt', branch: 'abc' } }) });
  try {
    const created = await harness.client.create({ repoPath: '/repo', base: '', slug: '' });
    assert.deepEqual(created, { path: '/repo/wt', branch: 'abc' });
    assert.deepEqual(harness.seen[0].body, { cwd: '/repo', intent: 'branch-off' });
  } finally {
    await harness.close();
  }
});

test('worktree: upstream refusals keep their meaning', async () => {
  const cases = [
    [{ status: 403, payload: { ok: false, error: 'workspace not authorized' } }, 'worktree-not-git-root'],
    [{ status: 422, payload: { ok: false, error: 'git repository required' } }, 'worktree-not-git-root'],
    [{ status: 422, payload: { ok: false, error: 'base did not resolve to a commit' } }, 'worktree-base-invalid'],
    [{ status: 502, payload: { ok: false, message: 'worktree: git failed' } }, 'worktree-create-failed'],
    [{ status: 404, payload: { ok: false, error: 'not found' } }, 'worktree-unavailable'],
  ];
  for (const [answer, code] of cases) {
    const harness = await boot({ reply: () => answer });
    try {
      await assert.rejects(
        () => harness.client.create({ repoPath: '/repo' }),
        (error) => {
          assert.equal(error.name, 'WorktreeError');
          assert.equal(error.code, code);
          return true;
        },
      );
    } finally {
      await harness.close();
    }
  }
});

test('worktree: a dead upstream is unavailable, with no stack trace escaping', async () => {
  const harness = await boot();
  await harness.close();
  const client = createWorktreeClient({ origin: () => harness.origin, now: () => BASE });
  await assert.rejects(
    () => client.create({ repoPath: '/repo' }),
    (error) => {
      assert.equal(error.code, 'worktree-unavailable');
      assert.match(error.message, /did not answer/u);
      return true;
    },
  );
});

test('worktree: a missing Host origin short-circuits', async () => {
  const client = createWorktreeClient({ origin: () => '' });
  assert.equal((await client.probe()).present, false);
  await assert.rejects(() => client.create({ repoPath: '/repo' }), (error) => error.code === 'worktree-unavailable');
});

test('worktree: slugs come from ASCII task names and vanish otherwise', () => {
  assert.equal(slugForTaskName('Nightly Tests'), 'nightly-tests');
  assert.equal(slugForTaskName('  Release / 3.2 prep  '), 'release-3-2-prep');
  assert.equal(slugForTaskName('夜间全量测试'), '');
  assert.equal(slugForTaskName(''), '');
  assert.equal(slugForTaskName('a'.repeat(80)).length, 40);
});
