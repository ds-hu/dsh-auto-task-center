# 11. Task Center also opens as a global sidebar page, beside 自动化任务

Date: 2026-11-17
Status: accepted

## Context

[ADR 1](0001-right-sidebar-entry.md) put Task Center in the right sidebar only, because the panel exists to
configure tasks that deliver into sessions and the reader is usually already in one. That is still true while
writing a task, but the list itself is Host-wide ([ADR 2](0002-one-global-task-list.md)), and two things are
awkward from a tab: checking schedules without opening a conversation, and editing a task with long settings
in a 360px column.

The left sidebar already carries global pages for neighbouring features — **Plugins** (order `0`),
**自动化任务** (`dsh-client-ui-schedule`, order `10`) and **MCP 管理** (order `20`) — and the request was to
put Task Center at that level, next to **自动化任务**.

## Decision

The same client half registers two surfaces:

- a `sidebar.panellist` row with `id: 'task-center'`, `order: 15`, a `nav.label` label and the existing
  list-and-clock glyph;
- a `main` page with `key: 'task-center'` rendering `TaskCenter` with `page: true`.

The existing right-sidebar tab and its guide entry stay. There is no header button, no shortcut and no
settings sub-page.

The page is master-detail: the list stays on the left while the detail view edits the selected task on the
right. Below 900px CSS hides the list while the detail is open, so the page degrades to the panel's single
column. Both surfaces render the same `TaskCenter` component and read the same `/state` poll, so their
behaviour cannot drift.

## Consequences

- **Task Center appears directly under 自动化任务** (order `10`) and above **MCP 管理** (`20`); the order is
  the contract, and a later plugin that picks `15` competes for the slot.
- The `sidebar.panellist` id must equal the `main` key, or ui-layout does not keep the panel selectable.
- `dsh.client.inject` now names `@deepseek-ai/dsh-client-ui-sidebar` and
  `@deepseek-ai/dsh-client-ui-layout`, the two plugins that declare those slots.
- The page is global: opening it does not depend on a session, a workspace or a selected agent preset, which
  matches the data it shows.
- The right tab remains the quick path from a conversation. ADR 1's reasoning still holds; it is simply no
  longer the only surface.
