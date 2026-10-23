# 9. One trigger per task, one event per run

Date: 2026-10-23
Status: accepted

## Context

The first release had six trigger kinds, five of which were clocks and one of which was `webhook`. They were
treated as siblings: `recomputeSchedule` special-cased `webhook`, `catchUp` skipped it, and delivery took an
optional `payload` that only a request could fill. That worked while every task *waited* for something.

Two requirements broke the shape.

1. A user wanted tasks that never fire on their own — only when they press a button, or when an agent asks.
2. More sources were coming (an HTTP API being the obvious next one), and each one would have to remember the
   same three special cases.

The obvious shortcut is to let a task have several triggers: a schedule *and* a webhook *and* a button. That
was rejected. A task that can be caused by three different things has no single answer to "why did this run
happen", which is the first question anyone asks of a background job — and the run record would need a union
of explanations rather than one.

## Decision

Separate **trigger** from **event**.

- A task owns exactly one trigger, and the trigger says what causes it: a schedule (`at`, `every`, `daily`,
  `weekly`, `cron`), an address (`webhook`), or nothing (`manual`).
- Every firing is an event with an explicit `source` — `schedule`, `http`, or `manual` — built by
  `lib/events.js` and dispatched through one `scheduler.dispatch(taskId, event)`.
- The source is stored on the run record. Pressing **Run now** on a scheduled task records `manual`; it does
  not pretend the schedule fired, and it does not touch `nextAt`.
- A manual task is enabled and idle: `status: 'active'` with no `nextAt`, exactly like a webhook task, so the
  panel and the scheduler need no fourth state.

`manual` was added rather than reusing `webhook` with an internal URL, because a secret URL is a credential to
protect and a button is not; writing a secret for a task that will only ever be clicked would be noise in the
store and in every export.

## Consequences

- The run record answers "why" for itself: `Manual · Session 3f2a1c`, `HTTP request · …`, or nothing when it
  was the schedule.
- A new source is one entry in `SOURCE_BY_KIND`, one `createEvent` call site, and one row in the panel — the
  scheduler, the deliverer and the store never learn about it.
- `manual` tasks carry a way to be run: the panel's **Run now** button (every task, not only manual ones) and
  the `task_center` tool's `run` action. The earlier rule that the tool deliberately had no way to fire a task
  is retired: `run` dispatches a `manual` event and never edits the trigger, so firing stays an explicit act
  that leaves the task exactly as it was.
- Stored records from earlier versions have no `source`; the field is optional and absent means "the
  schedule", which is what every one of those records was.
