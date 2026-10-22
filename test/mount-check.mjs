#!/usr/bin/env node
/**
 * Structural check of the shipped bundle.
 *
 * This is the test that would have caught every packaging mistake we hit while
 * writing the sibling plugins: a Loader row whose `id` disagrees with the
 * Host module's exported `name`, a patch file missing from `dsh.bundle.patch`,
 * an `exports` subpath pointing at a file that does not exist, and a preset
 * whose plugin list silently drifted away from the shipped `standard`.
 *
 * It reads files and imports two modules; it never boots a Host.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inject as hostInject, name as hostName, apply as hostApply } from '../lib/index.js';
import { apply as toolsApply, inject as toolsInject, name as toolsName } from '../lib/tools.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');
const manifest = JSON.parse(read('package.json'));

const failures = [];
/**
 * Record one assertion without aborting the rest of the audit.
 * @param {() => void} check - Assertion to run.
 * @param {string} label - What it checks.
 */
function check(checkName, fn) {
  try {
    fn();
    process.stdout.write(`ok   ${checkName}\n`);
  } catch (error) {
    failures.push(`${checkName}: ${error.message}`);
    process.stdout.write(`FAIL ${checkName}\n     ${error.message.split('\n').join('\n     ')}\n`);
  }
}

/* ---------------------------------------------------------------- */
/* modules                                                           */
/* ---------------------------------------------------------------- */

check('host module exports a name, inject and apply', () => {
  assert.equal(typeof hostName, 'string');
  assert.equal(hostName, 'dsh-auto-task-center');
  assert.ok(Array.isArray(hostInject));
  assert.deepEqual(hostInject, ['webServer', 'sessionController']);
  assert.equal(typeof hostApply, 'function');
});

check('tools module exports a name, inject and apply', () => {
  assert.equal(toolsName, 'task-center-tools');
  assert.deepEqual(toolsInject, ['tools']);
  assert.equal(typeof toolsApply, 'function');
});

/* ---------------------------------------------------------------- */
/* Loader patch                                                      */
/* ---------------------------------------------------------------- */

const hostPatch = read('cordis.patch.yml');

check('cordis.patch.yml inserts exactly one row', () => {
  const rows = hostPatch.split('\n').filter((line) => /^\s*-\s+id:/u.test(line));
  assert.equal(rows.length, 1, `expected one row, found ${rows.length}`);
});

check('the Loader row id equals the Host module name', () => {
  const id = /^\s*-\s+id:\s*(.+)$/mu.exec(hostPatch);
  assert.ok(id, 'no id in the patch');
  assert.equal(id[1].trim(), hostName);
});

check('the Loader row name is the package name', () => {
  const name = /^\s+name:\s*'?([^'\n]+)'?\s*$/mu.exec(hostPatch);
  assert.ok(name, 'no name in the patch');
  assert.equal(name[1].trim(), manifest.name);
});

check('the row is a root-level insert with no isolate group', () => {
  assert.match(hostPatch, /^- insert:$/mu);
  assert.doesNotMatch(hostPatch, /^\s+isolate:/mu);
});

/* ---------------------------------------------------------------- */
/* package.json                                                      */
/* ---------------------------------------------------------------- */

check('every patch file listed in dsh.bundle.patch exists', () => {
  const patches = manifest.dsh?.bundle?.patch;
  assert.ok(Array.isArray(patches) && patches.length > 0, 'dsh.bundle.patch is missing');
  for (const patch of patches) {
    assert.ok(existsSync(join(root, patch)), `${patch} does not exist`);
  }
});

check('the web client entry is declared', () => {
  assert.equal(manifest.dsh?.client?.platform, 'web');
  assert.ok(Array.isArray(manifest.dsh?.client?.inject));
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-sidebar-right'));
});

check('every exports subpath resolves to a real file', () => {
  for (const [subpath, target] of Object.entries(manifest.exports)) {
    const text = String(target);
    if (text.includes('*')) {
      // A pattern export: the directory before the wildcard must exist.
      const base = text.slice(0, text.indexOf('*'));
      assert.ok(existsSync(join(root, base)), `exports["${subpath}"] -> ${text} has no directory`);
      continue;
    }
    assert.ok(existsSync(join(root, text)), `exports["${subpath}"] -> ${text} does not exist`);
  }
});

check('the published file list covers every runtime artefact', () => {
  const files = manifest.files;
  for (const entry of ['lib', 'bin', 'presets', 'locale', 'cordis.patch.yml', 'icon.svg', 'LICENSE', 'NOTICE']) {
    assert.ok(files.includes(entry), `files[] is missing ${entry}`);
  }
});

check('the CLI is declared and starts with a shebang', () => {
  const bin = manifest.bin?.['dsh-auto-task-center'];
  assert.ok(bin, 'bin is missing');
  const text = read(bin);
  assert.ok(text.startsWith('#!/usr/bin/env node'), 'the CLI needs a shebang');
});

check('no lifecycle script can run during install', () => {
  for (const hook of ['preinstall', 'install', 'postinstall']) {
    assert.equal(manifest.scripts?.[hook], undefined, `${hook} must not be defined`);
  }
});

check('there are no runtime dependencies', () => {
  assert.deepEqual(manifest.dependencies ?? {}, {});
  assert.deepEqual(manifest.optionalDependencies ?? {}, {});
});

/* ---------------------------------------------------------------- */
/* agent preset                                                      */
/* ---------------------------------------------------------------- */

const presetPatch = read('presets/task-center.patch.yml');

/**
 * Read the `plugins:` block as id/name pairs.
 * @param {string} text - Patch file contents.
 * @returns {{ id: string, name?: string }[]} the rows.
 */
function pluginRows(text) {
  const rows = [];
  let current;
  for (const line of text.split('\n')) {
    const id = /^ {10}- id: (.+)$/u.exec(line);
    if (id !== null) {
      current = { id: id[1].trim() };
      rows.push(current);
      continue;
    }
    const name = /^ {12}name: (.+)$/u.exec(line);
    if (name !== null && current !== undefined) {
      current.name = name[1].trim().replaceAll(/^'|'$/gu, '');
    }
  }
  return rows;
}

const rows = pluginRows(presetPatch);

check('the preset patch inserts one preset row', () => {
  assert.match(presetPatch, /^- insert:$/mu);
  assert.equal(presetPatch.split('\n').filter((line) => /^\s*-\s+id:\s+preset-/u.test(line)).length, 1);
  assert.match(presetPatch, /^\s+name: '@deepseek-ai\/dsh-agent-preset'$/mu);
});

check('the preset identity and display name are the agreed ones', () => {
  assert.match(presetPatch, /^ {8}id: task-center$/mu);
  assert.match(presetPatch, /^ {8}name: 任务管理$/mu);
  assert.match(presetPatch, /^ {8}order: 5$/mu);
});

check('the preset carries a complete plugin list', () => {
  assert.ok(rows.length >= 20, `expected at least 20 rows, found ${rows.length}`);
  assert.ok(rows.every((row) => typeof row.name === 'string' && row.name !== ''), 'every row needs a name');
});

check('the preset swaps the official reminder tools for ours', () => {
  assert.equal(rows.some((row) => row.id === 'tool-schedule' || row.name === '@deepseek-ai/dsh-tool-schedule'), false, 'tool-schedule must be gone');
  const ours = rows.find((row) => row.id === 'task-center-tools');
  assert.ok(ours, 'task-center-tools is missing');
  assert.equal(ours.name, '@ds-hu/dsh-auto-task-center/tools');
});

check('the preset keeps the tools that make it standard-like', () => {
  const ids = rows.map((row) => row.id);
  for (const required of ['persona', 'agent-instructions', 'time-context', 'tool-bash', 'tool-fs', 'tool-fs-search', 'tool-jobs', 'tool-skill', 'command-goal', 'tool-goal', 'planning', 'compaction', 'delegation', 'tool-ask-user', 'tool-todo', 'tool-web', 'present']) {
    assert.ok(ids.includes(required), `${required} is missing`);
  }
});

check('the preset keeps the plan-mode instructions verbatim', () => {
  assert.match(presetPatch, /- id: plan-mode/u);
  assert.match(presetPatch, /exit_plan_mode/u);
});

check('the preset keeps the platform-conditional rows', () => {
  assert.match(presetPatch, /^ {12}disabled: !!js process\.platform === 'win32'$/mu);
});

const standardCandidates = [
  process.env.DSH_STANDARD_PRESET,
  '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml',
].filter((path) => typeof path === 'string' && path !== '' && existsSync(path));

check('the preset matches the shipped standard apart from the swap', () => {
  if (standardCandidates.length === 0) {
    process.stdout.write('     (skipped: the shipped standard preset was not found)\n');
    return;
  }
  const standardRows = pluginRows(readFileSync(standardCandidates[0], 'utf8'));
  const expected = standardRows.map((row) => (row.id === 'tool-schedule' ? { id: 'task-center-tools', name: '@ds-hu/dsh-auto-task-center/tools' } : row));
  assert.deepEqual(rows, expected, 'the preset drifted from the shipped standard');
});

/* ---------------------------------------------------------------- */
/* locale                                                            */
/* ---------------------------------------------------------------- */

check('both locale files carry the plugin-page metadata', () => {
  for (const locale of ['en', 'zh']) {
    const parsed = JSON.parse(read(`locale/${locale}.json`));
    assert.equal(typeof parsed.meta?.title, 'string');
    assert.equal(typeof parsed.meta?.description, 'string');
  }
});

/* ---------------------------------------------------------------- */

if (failures.length > 0) {
  process.stderr.write(`\n${failures.length} check(s) failed\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('\nmount-check: all checks passed\n');
}
