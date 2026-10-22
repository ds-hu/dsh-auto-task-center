# 6. The 任务管理 preset differs from `standard` by one row

Date: 2026-10-22
Status: accepted

## Context

DSH ships four presets; `standard` is the everyday one and already carries the official reminder tools
(`schedule_create`, `schedule_list`, `schedule_update`, `schedule_delete`). A task plugin needs the
agent to be able to write tasks, and two competing reminder tool sets in one agent is a recipe for the
model picking the wrong one.

## Decision

The preset is a **copy of `standard`** with the `tool-schedule` row replaced by this package's
`task-center-tools` row. Nothing else differs — same persona, same instructions, same tools, same
plan-mode text.

## Consequences

- Users get the familiar Standard-mode behaviour, plus one new tool. There is no second dialect of
  "how does this agent work" to learn.
- The copy is a real copy: when DSH changes `standard`, this file drifts. `test/mount-check.mjs`
  compares the two row by row and fails on any difference other than the swap, so an upgrade becomes a
  red test rather than a silently stale preset.
- The official tools are *absent*, not disabled, so the model cannot call them by accident.
