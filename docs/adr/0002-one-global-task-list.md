# 2. Tasks are global, not owned by a session

Date: 2026-10-22
Status: accepted

## Context

The panel lives inside a session, so tasks could plausibly belong to that session: "my tasks here".
Users, however, describe schedules in terms of the *work*, not in terms of which chat window was open
when they thought of it — "every morning at nine, summarise the repo" is a statement about the repo.

## Decision

There is **one task list per profile**. The session that hosts the tab is only a host: it supplies the
origin, the workspace list and the presets, and nothing else. No task records which session created it.

## Consequences

- A task keeps firing after the session that created it is closed, renamed or deleted.
- `list` in the `task_center` tool returns the whole profile's tasks, so a model can see — and avoid
  duplicating — work scheduled elsewhere.
- Two windows editing the same task can collide. That is handled by optimistic concurrency on
  `updatedAt` (a stale write answers `409`) rather than by partitioning tasks per session.
