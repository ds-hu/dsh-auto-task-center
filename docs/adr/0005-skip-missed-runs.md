# 5. Missed runs are skipped, not replayed

Date: 2026-10-22
Status: accepted

## Context

A laptop is closed; DSH is stopped for three days; a nightly task has four occurrences behind it when the
process starts again. Replaying them is defensible — the work was scheduled, after all — but it turns a
restart into a burst of agent sessions, and the first thing a user sees after opening their laptop is
four unattended runs.

## Decision

On start, the scheduler writes **one** `missed` record for the gap and schedules the next *future*
occurrence. It never fires a run whose time has passed while the process was down.

## Consequences

- Opening DSH never triggers a burst of work; the user decides when a missed task is worth running by
  editing its trigger or copying its message into a session.
- The history tells the truth about the gap instead of hiding it: one line saying several runs were
  skipped, with the most recent missed instant.
- A task that must run exactly once per period can encode that in its message ("if today's file already
  exists, skip"), which is a check the agent can do and the scheduler cannot.
