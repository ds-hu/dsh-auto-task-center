#!/usr/bin/env node
/**
 * dsh-auto-task-center maintenance CLI.
 *
 * The plugin writes to exactly one directory — `$DSH_HOME/task-center/` — so
 * uninstalling is "remove the bundle, then delete that directory". This command
 * makes the second step safe and explicit: it prints what it is about to
 * delete, refuses any path that is not that one directory, and never touches
 * anything else.
 *
 * Usage:
 *   dsh-auto-task-center path
 *   dsh-auto-task-center status
 *   dsh-auto-task-center purge [--yes]
 *
 * @module @ds-hu/dsh-auto-task-center/bin/task-center
 */
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { resolveDataDir, STORE_FILE } from '../lib/store.js';

/** Print the usage block. */
function usage() {
  process.stdout.write([
    'dsh-auto-task-center — maintenance for the Task Center plugin',
    '',
    '  dsh-auto-task-center path            print the data directory',
    '  dsh-auto-task-center status          show what is stored there',
    '  dsh-auto-task-center purge [--yes]   delete the data directory',
    '',
    'The data directory is the only thing this plugin ever writes. Removing the',
    'bundle removes the code, the Loader rows, the agent preset and the HTTP',
    'routes; purge removes the task records themselves.',
    '',
  ].join('\n'));
}

/**
 * Verify that a path is exactly the plugin's own data directory.
 *
 * The point of this check is that `purge` must be impossible to aim at
 * anything else — not the DSH home, not a workspace, not a directory a symlink
 * redirects to.
 *
 * @param {string} dir - Absolute data directory.
 * @returns {{ ok: true } | { ok: false, reason: string }} whether it is safe to delete.
 */
function assertOwnDataDir(dir) {
  if (basename(dir) !== 'task-center') return { ok: false, reason: `refusing: ${dir} is not named task-center` };
  let real;
  try {
    real = realpathSync(dir);
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true };
    return { ok: false, reason: `refusing: cannot resolve ${dir}: ${error?.message ?? error}` };
  }
  if (basename(real) !== 'task-center') return { ok: false, reason: `refusing: ${dir} resolves to ${real}` };
  let parentReal;
  try {
    parentReal = realpathSync(dirname(real));
  } catch (error) {
    return { ok: false, reason: `refusing: cannot resolve the parent of ${real}: ${error?.message ?? error}` };
  }
  if (dirname(real) !== parentReal) return { ok: false, reason: `refusing: ${real} is not directly inside ${parentReal}` };
  return { ok: true };
}

/**
 * Describe the data directory without changing it.
 * @param {string} dir - Absolute data directory.
 * @returns {{ exists: boolean, files: string[], tasks: number, bytes: number }} what is there.
 */
function describe(dir) {
  try {
    if (!statSync(dir).isDirectory()) return { exists: false, files: [], tasks: 0, bytes: 0 };
  } catch {
    return { exists: false, files: [], tasks: 0, bytes: 0 };
  }
  const files = readdirSync(dir);
  let bytes = 0;
  for (const file of files) {
    try {
      bytes += statSync(`${dir}/${file}`).size;
    } catch {
      // A file that vanished mid-scan simply does not count.
    }
  }
  let tasks = 0;
  try {
    const doc = JSON.parse(readFileSync(`${dir}/${STORE_FILE}`, 'utf8'));
    const raw = doc?.tasks;
    tasks = Array.isArray(raw) ? raw.length : (typeof raw === 'object' && raw !== null ? Object.keys(raw).length : 0);
  } catch {
    /* an unreadable store simply reports zero tasks */
  }
  return { exists: true, files, tasks, bytes };
}

/**
 * Ask a yes/no question on a terminal.
 * @param {string} question - Prompt text.
 * @returns {Promise<boolean>} the answer.
 */
async function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/iu.test(answer.trim());
  } finally {
    rl.close();
  }
}

/** Remind the operator about the one thing purge cannot fix. */
function presetReminder() {
  process.stdout.write([
    '',
    'Reminder: sessions created with the 任务管理 (task-center) preset record that preset id.',
    'Once this bundle is removed the preset no longer exists, and such a session cannot be',
    'resumed until it is switched to another preset. Switch those sessions first.',
    '',
    'Reminder: the browser also remembers which tabs were open. After the bundle is gone and',
    'the page is reloaded, a right-sidebar tab that held the panel shows a "nothing can view',
    'this" placeholder; close it once and the record is gone.',
    '',
  ].join('\n'));
}

const argv = process.argv.slice(2);
const command = argv[0] ?? 'help';
const dir = resolveDataDir();

switch (command) {
  case 'path':
    process.stdout.write(`${dir}\n`);
    break;
  case 'status': {
    const info = describe(dir);
    process.stdout.write(`data directory: ${dir}\n`);
    process.stdout.write(`exists: ${info.exists ? 'yes' : 'no'}\n`);
    if (info.exists) {
      process.stdout.write(`files: ${info.files.length === 0 ? '(none)' : info.files.join(', ')}\n`);
      process.stdout.write(`tasks: ${info.tasks}\n`);
      process.stdout.write(`bytes: ${info.bytes}\n`);
    }
    break;
  }
  case 'purge': {
    const safety = assertOwnDataDir(dir);
    if (!safety.ok) {
      process.stderr.write(`${safety.reason}\n`);
      process.exitCode = 1;
      break;
    }
    const info = describe(dir);
    if (!info.exists) {
      process.stdout.write(`nothing to purge: ${dir} does not exist\n`);
      break;
    }
    process.stdout.write(`about to delete: ${dir}\n`);
    process.stdout.write(`  ${info.files.length} file(s), ${info.tasks} task(s), ${info.bytes} byte(s)\n`);
    const assumeYes = argv.includes('--yes') || argv.includes('-y');
    if (!assumeYes) {
      if (!process.stdin.isTTY) {
        process.stderr.write('refusing to delete without a terminal; re-run with --yes\n');
        process.exitCode = 1;
        break;
      }
      const go = await confirm('Delete it?');
      if (!go) {
        process.stdout.write('cancelled\n');
        break;
      }
    }
    await rm(dir, { recursive: true, force: true });
    process.stdout.write(`deleted ${dir}\n`);
    presetReminder();
    break;
  }
  case 'help':
  case '--help':
  case '-h':
    usage();
    break;
  default:
    process.stderr.write(`unknown command: ${command}\n\n`);
    usage();
    process.exitCode = 1;
    break;
}
