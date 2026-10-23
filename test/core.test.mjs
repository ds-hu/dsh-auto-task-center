import assert from 'node:assert/strict';
import test from 'node:test';
import { CronError, cronMatchesDate, parseCron } from '../lib/cron.js';
import { countOccurrences, nextOccurrence, previewOccurrences } from '../lib/engine.js';
import { TaskInputError, normalizeDraft, sanitizeStoredTask, describeTrigger, describeTarget, withoutSecret } from '../lib/model.js';
import { isValidTimeZone, nextWallClockAfter, wallClockToInstants, zoneOffsetMs } from '../lib/zoned.js';

const BASE = Date.parse('2026-06-01T08:00:00Z');
const iso = (ms) => (ms === undefined ? undefined : new Date(ms).toISOString());
const at = (text) => Date.parse(text);

test('cron: accepts the documented subset', () => {
  assert.deepEqual(parseCron('* * * * *').minutes.length, 60);
  assert.deepEqual(parseCron('0 9 * * 1-5').hours, [9]);
  assert.deepEqual(parseCron('*/15 * * * *').minutes, [0, 15, 30, 45]);
  assert.deepEqual(parseCron('0 0 1,15 * *').days, [1, 15]);
  assert.deepEqual(parseCron('5-20/5 * * * *').minutes, [5, 10, 15, 20]);
  assert.deepEqual(parseCron('0 0 * * 7').weekdays, [7]);
  assert.equal(parseCron('  0   9  *  *  1-5 ').hours[0], 9);
});

test('cron: rejects everything outside the subset, naming the field', () => {
  for (const expression of ['', '* * * *', '* * * * * *', '@daily', '0 9 L * *', '0 9 * JAN *', '60 * * * *', '0 24 * * *', '*/0 * * * *', '5-1 * * * *', '0 9 * * MON']) {
    assert.throws(() => parseCron(expression), CronError, expression);
  }
  assert.throws(() => parseCron('60 * * * *'), /minute/u);
  assert.throws(() => parseCron('* 24 * * *'), /hour/u);
});

test('cron: day fields combine with either-match when both are restricted', () => {
  const both = parseCron('0 0 1 * 1');
  assert.equal(cronMatchesDate(both, { year: 2026, month: 6, day: 1 }), true, 'first of the month');
  assert.equal(cronMatchesDate(both, { year: 2026, month: 6, day: 8 }), true, 'a Monday');
  assert.equal(cronMatchesDate(both, { year: 2026, month: 6, day: 9 }), false, 'a Tuesday that is not the first');
  const domOnly = parseCron('0 0 13 * *');
  assert.equal(cronMatchesDate(domOnly, { year: 2026, month: 6, day: 13 }), true);
  assert.equal(cronMatchesDate(domOnly, { year: 2026, month: 6, day: 12 }), false);
});

test('cron: next occurrence respects zone, weekdays and February', () => {
  const from = at('2026-03-07T12:00:00Z');
  assert.equal(iso(nextOccurrence({ kind: 'cron', expression: '*/15 9-17 * * 1-5', timeZone: 'UTC' }, from)), '2026-03-09T09:00:00.000Z');
  assert.equal(iso(nextOccurrence({ kind: 'cron', expression: '0 0 29 2 *', timeZone: 'UTC' }, at('2026-03-01T00:00:00Z'))), '2028-02-29T00:00:00.000Z');
  assert.equal(iso(nextOccurrence({ kind: 'cron', expression: '30 7 * * *', timeZone: 'Asia/Shanghai' }, at('2026-03-07T00:00:00Z'))), '2026-03-07T23:30:00.000Z');
});

test('zoned: offsets and instants agree', () => {
  assert.equal(zoneOffsetMs('UTC', at('2026-06-01T00:00:00Z')), 0);
  assert.equal(zoneOffsetMs('Asia/Shanghai', at('2026-06-01T00:00:00Z')), 8 * 3600000);
  assert.equal(zoneOffsetMs('America/New_York', at('2026-01-15T12:00:00Z')), -5 * 3600000);
  assert.equal(zoneOffsetMs('America/New_York', at('2026-07-15T12:00:00Z')), -4 * 3600000);
  assert.equal(isValidTimeZone('Asia/Shanghai'), true);
  assert.equal(isValidTimeZone('Mars/Olympus'), false);
  assert.equal(isValidTimeZone(''), false);
});

test('zoned: a spring-forward gap has no instant, an autumn overlap has two', () => {
  assert.deepEqual(wallClockToInstants('America/New_York', { year: 2026, month: 3, day: 8, hour: 2, minute: 30 }), []);
  const overlap = wallClockToInstants('America/New_York', { year: 2026, month: 11, day: 1, hour: 1, minute: 30 });
  assert.equal(overlap.length, 2);
  assert.ok(overlap[0] < overlap[1]);
});

test('zoned: a vanished wall clock is skipped, a repeated one fires once', () => {
  const daily = (time) => ({ kind: 'daily', time, timeZone: 'America/New_York' });
  assert.deepEqual(
    previewOccurrences(daily('02:30:00'), at('2026-03-07T12:00:00Z'), 2),
    ['2026-03-09T06:30:00.000Z', '2026-03-10T06:30:00.000Z'],
  );
  assert.deepEqual(
    previewOccurrences(daily('01:30:00'), at('2026-10-31T12:00:00Z'), 3),
    ['2026-11-01T05:30:00.000Z', '2026-11-02T06:30:00.000Z', '2026-11-03T06:30:00.000Z'],
  );
});

test('zoned: nextWallClockAfter honours the day predicate', () => {
  const next = nextWallClockAfter('UTC', {
    hours: [9],
    minutes: [0],
    matchDay: (date) => date.day === 13,
  }, at('2026-06-01T00:00:00Z'));
  assert.equal(iso(next), '2026-06-13T09:00:00.000Z');
});

test('engine: every is anchored and strictly after the boundary', () => {
  const trigger = { kind: 'every', everySeconds: 60, anchorAt: '2026-03-07T12:00:05.000Z' };
  assert.equal(iso(nextOccurrence(trigger, at('2026-03-07T12:00:00Z'))), '2026-03-07T12:00:05.000Z');
  assert.equal(iso(nextOccurrence(trigger, at('2026-03-07T12:00:05Z'))), '2026-03-07T12:01:05.000Z');
  assert.equal(iso(nextOccurrence(trigger, at('2026-03-07T12:00:06Z'))), '2026-03-07T12:01:05.000Z');
});

test('engine: a one-shot in the future has one occurrence, in the past none', () => {
  assert.equal(nextOccurrence({ kind: 'at', at: '2026-05-01T00:00:00.000Z' }, at('2026-04-01T00:00:00Z')), at('2026-05-01T00:00:00Z'));
  assert.equal(nextOccurrence({ kind: 'at', at: '2026-05-01T00:00:00.000Z' }, at('2026-06-01T00:00:00Z')), undefined);
  assert.equal(nextOccurrence({ kind: 'webhook', secret: 'a'.repeat(32) }, Date.now()), undefined);
});

test('engine: missed occurrences are counted, not delivered', () => {
  const every = { kind: 'every', everySeconds: 60, anchorAt: '2026-03-07T10:00:05.000Z' };
  assert.deepEqual(countOccurrences(every, at('2026-03-07T10:00:00Z'), at('2026-03-07T12:00:00Z')), {
    count: 120,
    last: at('2026-03-07T12:00:05Z') - 60000,
    truncated: false,
  });
  const hourly = { kind: 'cron', expression: '0 * * * *', timeZone: 'UTC' };
  assert.equal(countOccurrences(hourly, at('2026-03-07T10:00:00Z'), at('2026-03-07T12:00:00Z')).count, 2);
  assert.equal(countOccurrences(hourly, at('2026-03-07T12:00:00Z'), at('2026-03-07T12:00:00Z')).count, 0);
  assert.equal(countOccurrences(hourly, at('2026-03-07T00:00:00Z'), at('2026-03-07T00:00:31Z')).count, 0);
});

test('engine: the preview stops when a one-shot is spent', () => {
  assert.deepEqual(previewOccurrences({ kind: 'at', at: '2026-05-01T00:00:00.000Z' }, at('2026-04-01T00:00:00Z'), 5), ['2026-05-01T00:00:00.000Z']);
});

test('model: a full draft normalizes', () => {
  const nowMs = at('2026-06-01T00:00:00Z');
  const task = normalizeDraft({
    name: '  Nightly  ',
    trigger: { kind: 'daily', time: '9:00', timeZone: 'Asia/Shanghai' },
    target: { kind: 'newSession', workspaceId: 'ws-1', agentPreset: 'standard' },
    message: { text: 'go' },
  }, { nowMs });
  assert.equal(task.name, 'Nightly');
  assert.equal(task.trigger.time, '09:00:00');
  assert.equal(task.enabled, true);
  assert.equal(task.state.status, 'active');
  assert.match(task.id, /^task-[0-9a-f-]{36}$/u);
});

test('model: webhook secrets are minted once and reused on update', () => {
  const nowMs = at('2026-06-01T00:00:00Z');
  const base = {
    name: 'hook',
    trigger: { kind: 'webhook' },
    target: { kind: 'session', sessionId: 's-1' },
    message: { text: 'hi' },
  };
  const first = normalizeDraft(base, { nowMs });
  assert.match(first.trigger.secret, /^[0-9a-f]{32}$/u);
  const again = normalizeDraft({ ...base, trigger: { kind: 'webhook' } }, { nowMs, existing: first });
  assert.equal(again.trigger.secret, first.trigger.secret);
  assert.equal(again.id, first.id);
});

test('model: drafts that cannot work are rejected with a stable code', () => {
  const nowMs = at('2026-06-01T00:00:00Z');
  const good = {
    name: 'x',
    trigger: { kind: 'daily', time: '09:00', timeZone: 'UTC' },
    target: { kind: 'session', sessionId: 's' },
    message: { text: 'body' },
  };
  const cases = [
    [{ ...good, name: '   ' }, 'name/invalid'],
    [{ ...good, trigger: { kind: 'nope' } }, 'trigger/unknown-kind'],
    [{ ...good, trigger: { kind: 'at', at: '2020-01-01T00:00:00Z' } }, 'trigger/at-past'],
    [{ ...good, trigger: { kind: 'every', everySeconds: 30 } }, 'trigger/every-invalid'],
    [{ ...good, trigger: { kind: 'daily', time: '25:00', timeZone: 'UTC' } }, 'trigger/time-invalid'],
    [{ ...good, trigger: { kind: 'daily', time: '09:00', timeZone: 'Nope/Nope' } }, 'trigger/time-zone-invalid'],
    [{ ...good, trigger: { kind: 'weekly', time: '09:00', timeZone: 'UTC', weekdays: [] } }, 'trigger/weekdays-invalid'],
    [{ ...good, trigger: { kind: 'cron', expression: 'bad', timeZone: 'UTC' } }, 'trigger/cron-invalid'],
    [{ ...good, target: { kind: 'newSession' } }, 'target/missing'],
    [{ ...good, target: { kind: 'newSession', workspaceId: 'a', cwd: '/tmp' } }, 'target/ambiguous'],
    [{ ...good, message: { text: '  ' } }, 'message/empty'],
  ];
  for (const [draft, code] of cases) {
    let error;
    try {
      normalizeDraft(draft, { nowMs });
    } catch (caught) {
      error = caught;
    }
    assert.ok(error instanceof TaskInputError, `${code} should be a TaskInputError`);
    assert.equal(error.code, code, code);
  }
});

test('model: stored records survive a round trip and drop the damaged ones', () => {
  const nowMs = at('2026-06-01T00:00:00Z');
  const task = normalizeDraft({
    name: 'keep',
    trigger: { kind: 'cron', expression: '0 9 * * *', timeZone: 'UTC' },
    target: { kind: 'session', sessionId: 's-1' },
    message: { text: 'body' },
  }, { nowMs });
  assert.deepEqual(sanitizeStoredTask(task), task);
  assert.equal(sanitizeStoredTask({ ...task, id: 'nope' }), null);
  assert.equal(sanitizeStoredTask({ ...task, trigger: { kind: 'webhook', secret: 'short' } }), null);
  assert.equal(sanitizeStoredTask({ ...task, message: { text: '' } }), null);
  const repaired = sanitizeStoredTask({ ...task, state: {}, history: [{ result: 'ok', at: 'nope', detail: 'x' }] });
  assert.equal(repaired.state.status, 'active');
  assert.deepEqual(repaired.history, []);
});

test('model: a past one-shot is still loadable', () => {
  const task = sanitizeStoredTask({
    id: 'task-11111111-2222-3333-4444-555555555555',
    name: 'gone',
    enabled: true,
    trigger: { kind: 'at', at: '2020-01-01T00:00:00.000Z' },
    target: { kind: 'session', sessionId: 's' },
    message: { text: 'x' },
    state: { status: 'active', evaluatedThrough: '2020-01-01T00:00:00.000Z' },
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:00.000Z',
  });
  assert.notEqual(task, null);
  assert.equal(task.trigger.at, '2020-01-01T00:00:00.000Z');
});

test('model: summaries and secret masking', () => {
  assert.equal(describeTrigger({ kind: 'daily', time: '09:00:00', timeZone: 'UTC' }), 'daily 09:00:00 UTC');
  assert.equal(describeTarget({ kind: 'newSession', workspaceId: 'ws' }), 'new session in ws');
  const view = withoutSecret({ trigger: { kind: 'webhook', secret: 'abc' } });
  assert.equal(view.trigger.secret, '***');
  const plain = withoutSecret({ trigger: { kind: 'daily' } });
  assert.equal(plain.trigger.kind, 'daily');
});

test('model: a worktree modifier survives a round trip and stays tied to a workspace', () => {
  const plain = normalizeDraft({
    name: 'nightly',
    trigger: { kind: 'daily', time: '09:00', timeZone: 'UTC' },
    target: { kind: 'newSession', workspaceId: 'ws-1', worktree: {} },
    message: { text: 'run checks' },
  }, { nowMs: BASE });
  assert.deepEqual(plain.target, { kind: 'newSession', workspaceId: 'ws-1', worktree: {} }, 'an empty modifier means the default branch');

  const pinned = normalizeDraft({
    name: 'nightly',
    trigger: { kind: 'daily', time: '09:00', timeZone: 'UTC' },
    target: { kind: 'newSession', workspaceId: 'ws-1', worktree: { base: '  release/3.2  ' } },
    message: { text: 'run checks' },
  }, { nowMs: BASE });
  assert.equal(pinned.target.worktree.base, 'release/3.2');

  assert.throws(
    () => normalizeDraft({
      name: 'bad',
      trigger: { kind: 'daily', time: '09:00', timeZone: 'UTC' },
      target: { kind: 'newSession', cwd: '/work/x', worktree: {} },
      message: { text: 'body' },
    }, { nowMs: BASE }),
    (error) => error instanceof TaskInputError && error.code === 'target/worktree-cwd',
  );
  assert.throws(
    () => normalizeDraft({
      name: 'bad',
      trigger: { kind: 'daily', time: '09:00', timeZone: 'UTC' },
      target: { kind: 'newSession', workspaceId: 'ws-1', worktree: { base: 7 } },
      message: { text: 'body' },
    }, { nowMs: BASE }),
    (error) => error instanceof TaskInputError && error.code === 'target/worktree-base-invalid',
  );
});

test('model: stored worktree targets are re-validated, not trusted', () => {
  const base = {
    id: 'task-11111111-2222-3333-4444-555555555555',
    name: 'nightly',
    enabled: true,
    trigger: { kind: 'daily', time: '09:00:00', timeZone: 'UTC' },
    message: { text: 'body' },
    state: {},
    history: [],
    createdAt: new Date(BASE).toISOString(),
    updatedAt: new Date(BASE).toISOString(),
  };
  const kept = sanitizeStoredTask({ ...base, target: { kind: 'newSession', workspaceId: 'ws-1', worktree: { base: 'main' } } });
  assert.deepEqual(kept.target.worktree, { base: 'main' });
  const stripped = sanitizeStoredTask({ ...base, target: { kind: 'newSession', workspaceId: 'ws-1', worktree: { base: '' } } });
  assert.deepEqual(stripped.target.worktree, {}, 'an empty base falls back to the default branch');
  const orphan = sanitizeStoredTask({ ...base, target: { kind: 'newSession', cwd: '/work/x', worktree: { base: 'main' } } });
  assert.equal(orphan.target.worktree, undefined, 'a directory target cannot carry a worktree');
});

test('model: the target summary names the worktree and its base', () => {
  assert.equal(
    describeTarget({ kind: 'newSession', workspaceId: 'ws-1', worktree: {} }),
    'new session in ws-1 in a fresh worktree off the default branch',
  );
  assert.equal(
    describeTarget({ kind: 'newSession', workspaceId: 'ws-1', worktree: { base: 'main' }, agentPreset: 'standard' }),
    'new session in ws-1 in a fresh worktree off main (standard)',
  );
  assert.equal(describeTarget({ kind: 'newSession', workspaceId: 'ws-1' }), 'new session in ws-1');
});

test('model: a new session can pin its model and permission', () => {
  const draft = normalizeDraft({
    name: 'nightly',
    trigger: { kind: 'daily', time: '09:00', timeZone: 'UTC' },
    target: {
      kind: 'newSession',
      workspaceId: 'ws-1',
      model: { provider: ' deepseek ', model: ' deepseek-chat ', reasoningEffort: 'high' },
      permission: ' read-only ',
    },
    message: { text: 'run checks' },
  }, { nowMs: BASE });
  assert.deepEqual(draft.target.model, { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' });
  assert.equal(draft.target.permission, 'read-only');

  const plain = normalizeDraft({
    name: 'nightly',
    trigger: { kind: 'daily', time: '09:00', timeZone: 'UTC' },
    target: { kind: 'newSession', workspaceId: 'ws-1', model: { provider: 'a', model: 'b' } },
    message: { text: 'run checks' },
  }, { nowMs: BASE });
  assert.deepEqual(plain.target.model, { provider: 'a', model: 'b' }, 'an omitted effort stays omitted');
});

test('model: unusable model and permission shapes are rejected by name', () => {
  const base = {
    name: 'nightly',
    trigger: { kind: 'daily', time: '09:00', timeZone: 'UTC' },
    message: { text: 'run checks' },
  };
  assert.throws(
    () => normalizeDraft({ ...base, target: { kind: 'newSession', workspaceId: 'ws-1', model: { provider: 'a' } } }, { nowMs: BASE }),
    (error) => error.code === 'target/model-invalid',
  );
  assert.throws(
    () => normalizeDraft({ ...base, target: { kind: 'newSession', workspaceId: 'ws-1', model: 7 } }, { nowMs: BASE }),
    (error) => error.code === 'target/model-invalid',
  );
  assert.throws(
    () => normalizeDraft({ ...base, target: { kind: 'newSession', workspaceId: 'ws-1', permission: 'read only!' } }, { nowMs: BASE }),
    (error) => error.code === 'target/permission-invalid',
  );
  assert.throws(
    () => normalizeDraft({ ...base, target: { kind: 'session', sessionId: 's-1', permission: 'read-only' } }, { nowMs: BASE }),
    (error) => error.code === 'target/model-session',
  );
});

test('model: stored targets keep a valid pair and drop a broken one', () => {
  const base = {
    id: 'task-11111111-2222-3333-4444-555555555555',
    name: 'nightly',
    enabled: true,
    trigger: { kind: 'daily', time: '09:00:00', timeZone: 'UTC' },
    message: { text: 'body' },
    state: {},
    history: [],
    createdAt: new Date(BASE).toISOString(),
    updatedAt: new Date(BASE).toISOString(),
  };
  const kept = sanitizeStoredTask({
    ...base,
    target: { kind: 'newSession', workspaceId: 'ws-1', model: { provider: 'deepseek', model: 'deepseek-chat' }, permission: 'workspace-write' },
  });
  assert.deepEqual(kept.target.model, { provider: 'deepseek', model: 'deepseek-chat' });
  assert.equal(kept.target.permission, 'workspace-write');
  const broken = sanitizeStoredTask({ ...base, target: { kind: 'newSession', workspaceId: 'ws-1', model: { provider: '' }, permission: 'bad name' } });
  assert.equal(broken.target.model, undefined);
  assert.equal(broken.target.permission, undefined);
});

test('model: the reasoning effort is an id, and a stored one that is not is dropped', () => {
  const task = normalizeDraft({
    name: 'effort',
    trigger: { kind: 'manual' },
    target: { kind: 'newSession', workspaceId: 'ws-1', model: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: ' high ' } },
    message: { text: 'body' },
  }, { nowMs: BASE });
  assert.deepEqual(task.target.model, { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' });

  for (const bad of ['high effort', 'high!', '-high', 'h'.repeat(65)]) {
    assert.throws(
      () => normalizeDraft({
        name: 'effort',
        trigger: { kind: 'manual' },
        target: { kind: 'newSession', workspaceId: 'ws-1', model: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: bad } },
        message: { text: 'body' },
      }, { nowMs: BASE }),
      (error) => error.code === 'target/effort-invalid',
      bad,
    );
  }

  const stored = sanitizeStoredTask({
    ...task,
    target: { kind: 'newSession', workspaceId: 'ws-1', model: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'not a key' } },
    updatedAt: new Date(BASE).toISOString(),
  });
  assert.deepEqual(stored.target.model, { provider: 'deepseek', model: 'deepseek-chat' }, 'the model survives, the effort does not');
});

test('model: the target summary names the model and the permission', () => {
  assert.equal(
    describeTarget({ kind: 'newSession', workspaceId: 'ws-1', model: { provider: 'deepseek', model: 'deepseek-chat' } }),
    'new session in ws-1 using deepseek-chat',
  );
  assert.equal(
    describeTarget({ kind: 'newSession', workspaceId: 'ws-1', permission: 'read-only', agentPreset: 'standard' }),
    'new session in ws-1 (standard, read-only)',
  );
  assert.equal(
    describeTarget({ kind: 'newSession', workspaceId: 'ws-1', permission: 'read-only' }),
    'new session in ws-1 (read-only)',
  );
  assert.equal(
    describeTarget({ kind: 'newSession', workspaceId: 'ws-1', model: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'max' }, permission: 'read-only' }),
    'new session in ws-1 using deepseek-chat at max effort (read-only)',
  );
});
