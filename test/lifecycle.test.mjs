import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'bin', 'task-center.mjs');

/**
 * Run the CLI against a disposable DSH home.
 * @param {string} home - Value for DSH_HOME.
 * @param {string[]} args - CLI arguments.
 * @returns {Promise<{ stdout: string, stderr: string, code: number }>} the result.
 */
async function cliRun(home, args) {
  try {
    const result = await run(process.execPath, [cli, ...args], {
      env: { ...process.env, DSH_HOME: home },
      encoding: 'utf8',
    });
    return { ...result, code: 0 };
  } catch (error) {
    return { stdout: error.stdout ?? '', stderr: error.stderr ?? '', code: error.code ?? 1 };
  }
}

test('lifecycle: mounting and disposing leaves the disk untouched', async () => {
  const home = await mkdtemp(join(tmpdir(), 'task-center-life-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const { apply } = await import('../lib/index.js');
  const { getRuntime } = await import('../lib/runtime.js');

  const routes = [];
  const disposers = [];
  const ctx = {
    webServer: {
      getOrigin: () => 'http://127.0.0.1:9999',
      register(route) {
        routes.push(route);
        return () => {
          const index = routes.indexOf(route);
          if (index >= 0) routes.splice(index, 1);
        };
      },
    },
    sessionController: {
      async prompt() {
        return { accepted: true };
      },
    },
    get: () => undefined,
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === 'function') disposers.push(dispose);
      return dispose;
    },
  };

  try {
    apply(ctx);
    assert.equal(routes.length, 1);
    assert.equal(routes[0].kind, 'prefix');
    assert.equal(routes[0].path, '/task-center');
    assert.ok(getRuntime() !== undefined, 'the tool half needs a runtime while mounted');

    assert.equal(existsSync(join(home, 'task-center')), false, 'mounting must not create the data directory');

    for (const dispose of disposers.reverse()) await dispose();

    assert.equal(routes.length, 0, 'the route is unregistered on dispose');
    assert.equal(getRuntime(), undefined, 'the runtime singleton is cleared');
    assert.equal(existsSync(join(home, 'task-center')), false, 'disposing deletes nothing and creates nothing');
    assert.deepEqual(await readdir(home), [], 'the DSH home is untouched');
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
});

test('lifecycle: dispose is idempotent', async () => {
  const home = await mkdtemp(join(tmpdir(), 'task-center-twice-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const { apply } = await import('../lib/index.js');
  const disposers = [];
  const ctx = {
    webServer: { getOrigin: () => 'http://127.0.0.1:9999', register: () => () => {} },
    sessionController: { async prompt() { return { accepted: true }; } },
    get: () => undefined,
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === 'function') disposers.push(dispose);
      return dispose;
    },
  };
  try {
    apply(ctx);
    for (const dispose of disposers) await dispose();
    for (const dispose of disposers) await dispose();
    assert.equal(existsSync(join(home, 'task-center')), false);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
});

test('cli: path and status describe the data directory', async () => {
  const home = await mkdtemp(join(tmpdir(), 'task-center-cli-'));
  const dataDir = join(home, 'task-center');
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, 'tasks.json'), JSON.stringify({ version: 1, tasks: { a: {}, b: {} } }), 'utf8');

  const path = await cliRun(home, ['path']);
  assert.equal(path.code, 0);
  assert.equal(path.stdout.trim(), dataDir);

  const status = await cliRun(home, ['status']);
  assert.equal(status.code, 0);
  assert.match(status.stdout, /exists: yes/u);
  assert.match(status.stdout, /tasks: 2/u);
  assert.match(status.stdout, /tasks\.json/u);
});

test('cli: purge deletes only the plugin directory', async () => {
  const home = await mkdtemp(join(tmpdir(), 'task-center-purge-'));
  const dataDir = join(home, 'task-center');
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, 'tasks.json'), JSON.stringify({ version: 1, tasks: {} }), 'utf8');
  await writeFile(join(home, 'keep-me.txt'), 'do not delete', 'utf8');

  const purged = await cliRun(home, ['purge', '--yes']);
  assert.equal(purged.code, 0);
  assert.match(purged.stdout, /deleted /u);
  assert.match(purged.stdout, /task-center\) preset/u, 'the preset reminder is printed');
  assert.equal(existsSync(dataDir), false);
  assert.ok(existsSync(join(home, 'keep-me.txt')), 'a sibling file survives');
  assert.ok((await stat(home)).isDirectory(), 'the DSH home survives');
});

test('cli: purge is idempotent and refuses a non-terminal run without --yes', async () => {
  const home = await mkdtemp(join(tmpdir(), 'task-center-idem-'));
  const again = await cliRun(home, ['purge', '--yes']);
  assert.equal(again.code, 0);
  assert.match(again.stdout, /nothing to purge/u);

  const dataDir = join(home, 'task-center');
  await mkdir(dataDir, { recursive: true });
  const refused = await cliRun(home, ['purge']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /--yes/u);
  assert.ok(existsSync(dataDir), 'a refused purge deletes nothing');
});

test('cli: unknown commands explain themselves', async () => {
  const home = await mkdtemp(join(tmpdir(), 'task-center-help-'));
  const help = await cliRun(home, ['help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /purge/u);
  const unknown = await cliRun(home, ['frobnicate']);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /unknown command/u);
});
