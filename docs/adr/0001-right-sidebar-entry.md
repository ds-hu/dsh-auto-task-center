# 1. Task Center is a right-sidebar tab, not a left-rail page

Date: 2026-10-22
Status: accepted

## Context

DSH offers several places to put a new surface: a left-rail global page (`Plugins`, `Automation tasks`),
a right-sidebar tab per session, a header button, or a keyboard shortcut. The panel exists to configure
tasks that deliver *into sessions*, and the user is usually already looking at a session when they want
to check or add one.

## Decision

Task Center registers a **right-sidebar tab type** plus one entry on the right sidebar's start page.
There is no left-rail entry, no header button and no shortcut.

## Consequences

- The panel sits next to the conversation it will deliver into, which is exactly the context needed to
  write a target and a message.
- The right sidebar has no collapsed rail of its own, so the panel cannot be opened when the sidebar is
  closed. The start page is the discovery point, and it is visible the moment the sidebar opens.
- The tab is per session by construction. Tasks are not: they are global (see ADR 2), and the tab is
  only a view. Two sessions open on the same tab show the same list.
