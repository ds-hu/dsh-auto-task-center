#!/usr/bin/env node
/**
 * Check what `npm publish` would actually upload.
 *
 * The published tarball is the only artefact an installer ever sees, so a file
 * that is used at runtime but missing from `files[]` is a broken release, and a
 * file that is only used in development must not be in it. This runs
 * `npm pack --dry-run --json` and audits the result.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
  cwd: root,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});
const [report] = JSON.parse(raw);
const paths = report.files.map((file) => file.path).sort();

const failures = [];
/**
 * Run one labelled assertion.
 * @param {string} label - What is being checked.
 * @param {() => void} fn - The check.
 * @returns {void}
 */
function check(label, fn) {
  try {
    fn();
    process.stdout.write(`ok   ${label}\n`);
  } catch (error) {
    failures.push(label);
    process.stdout.write(`FAIL ${label}\n     ${String(error.message).split('\n').join('\n     ')}\n`);
  }
}

/**
 * Whether the tarball carries a path.
 * @param {string} path - Path inside the package.
 * @returns {boolean} the answer.
 */
const has = (path) => paths.includes(path);

check('the tarball carries every runtime file', () => {
  for (const path of [
    'lib/api.js',
    'lib/client.js',
    'lib/cron.js',
    'lib/deliver.js',
    'lib/engine.js',
    'lib/http.js',
    'lib/index.js',
    'lib/model.js',
    'lib/runtime.js',
    'lib/scheduler.js',
    'lib/store.js',
    'lib/tool-definition.js',
    'lib/tools.js',
    'lib/version.js',
    'lib/worktree.js',
    'lib/zoned.js',
    'bin/task-center.mjs',
    'presets/task-center.patch.yml',
    'cordis.patch.yml',
    'locale/en.json',
    'locale/zh.json',
    'icon.svg',
  ]) {
    assert.ok(has(path), `${path} is missing from the tarball`);
  }
});

check('the tarball carries the legal and documentation files', () => {
  for (const path of ['LICENSE', 'NOTICE', 'README.md', 'README.zh-CN.md', 'CONTEXT.md', 'docs/TECHNICAL.md', 'package.json']) {
    assert.ok(has(path), `${path} is missing from the tarball`);
  }
});

check('screenshots ship so the README images resolve on npm', () => {
  const shots = paths.filter((path) => path.startsWith('docs/screenshots/'));
  assert.ok(shots.length >= 8, `only ${shots.length} screenshots in the tarball`);
});

check('development files stay out of the tarball', () => {
  for (const prefix of ['test/', '.github/', 'node_modules/']) {
    assert.equal(paths.some((path) => path.startsWith(prefix)), false, `${prefix} leaked into the tarball`);
  }
  for (const path of ['eslint.config.js', 'package-lock.json', '.gitignore']) {
    assert.equal(has(path), false, `${path} leaked into the tarball`);
  }
});

check('no stray backup or quarantine files are shipped', () => {
  const strays = paths.filter((path) => /\.corrupt-|\.tmp-|\.tgz$|~$/u.test(path));
  assert.deepEqual(strays, []);
});

if (failures.length > 0) {
  process.stderr.write(`\n${failures.length} check(s) failed\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`\npackage: ${paths.length} files, all checks passed\n`);
}
