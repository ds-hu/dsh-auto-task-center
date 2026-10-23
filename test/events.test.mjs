import assert from 'node:assert/strict';
import test from 'node:test';
import { EVENT_SOURCES, createEvent, describeEvent, sourceOfTrigger, waitsForEvent } from '../lib/events.js';
import { normalizeDraft, sanitizeStoredTask } from '../lib/model.js';

const BASE = Date.parse('2026-06-01T08:00:00Z');

test('events: every trigger kind maps to exactly one source', () => {
  assert.deepEqual(EVENT_SOURCES, ['schedule', 'http', 'manual']);
  for (const kind of ['at', 'every', 'daily', 'weekly', 'cron']) assert.equal(sourceOfTrigger(kind), 'schedule', kind);
  assert.equal(sourceOfTrigger('webhook'), 'http');
  assert.equal(sourceOfTrigger('manual'), 'manual');
});

test('events: event triggers wait for an act, schedules wait for the clock', () => {
  assert.equal(waitsForEvent('daily'), false);
  assert.equal(waitsForEvent('webhook'), true);
  assert.equal(waitsForEvent('manual'), true);
});

test('events: createEvent keeps only the fields its source carries', () => {
  const scheduled = createEvent({ source: 'schedule', at: BASE });
  assert.deepEqual(scheduled, { source: 'schedule', at: new Date(BASE).toISOString() });

  const http = createEvent({ source: 'http', at: BASE, payload: 'body' });
  assert.equal(http.payload, 'body');
  assert.equal(http.actor, undefined);

  const manual = createEvent({ source: 'manual', at: BASE, actor: 'panel' });
  assert.equal(manual.actor, 'panel');
  assert.equal(manual.payload, undefined, 'an empty payload is not stored');

  assert.equal(createEvent({ source: 'http', at: BASE, payload: '' }).payload, undefined);
});

test('events: each source has a readable description', () => {
  assert.equal(describeEvent({ source: 'schedule' }), 'scheduled run');
  assert.equal(describeEvent({ source: 'http' }), 'HTTP request');
  assert.equal(describeEvent({ source: 'manual' }), 'manual run');
  assert.equal(describeEvent({ source: 'manual', actor: 'tool' }), 'manual run (tool)');
});

test('model: a manual draft needs nothing but a name, target and body', () => {
  const task = normalizeDraft({
    name: 'by hand',
    trigger: { kind: 'manual' },
    target: { kind: 'session', sessionId: 's-1' },
    message: { text: 'body' },
  }, { nowMs: BASE });
  assert.deepEqual(task.trigger, { kind: 'manual' });
  assert.equal(sanitizeStoredTask({ ...task, updatedAt: new Date(BASE).toISOString() }).trigger.kind, 'manual');
});

test('model: a stored record keeps the source of each run', () => {
  const task = normalizeDraft({
    name: 'by hand',
    trigger: { kind: 'manual' },
    target: { kind: 'session', sessionId: 's-1' },
    message: { text: 'body' },
  }, { nowMs: BASE });
  task.history = [{ runId: 'run-1', at: new Date(BASE).toISOString(), result: 'ok', source: 'manual', detail: 'delivered' }];
  const stored = sanitizeStoredTask(task);
  assert.equal(stored.history[0].source, 'manual');
  assert.equal(stored.history[0].result, 'ok');
});
