# 4. Delivery prompts a session instead of spawning a headless agent

Date: 2026-10-22
Status: accepted

## Context

A scheduled run needs an agent to do the work. DSH can start a headless run (`dsh headless "…"`) or
prompt an existing session through `sessionController`. The headless route is isolated and easy to reason
about; the session route is what the composer itself does.

## Decision

Every run goes through `sessionController.create` / `prompt`, optionally prefixed by `commands.execute`
for `/goal` mode. The plugin never spawns a process and never talks to a model provider.

## Consequences

- The delivered text is a **user message** — the same shape the composer produces, including
  `source.kind = 'user'`. Slash commands and skill gestures therefore work exactly as if typed, which a
  hand-rolled message injection would not achieve.
- A run against a busy session queues (`mode: 'queue'`) rather than interrupting the person using it.
- The run's output lands in a real session with a real transcript, so the user can read, continue or
  reply to it afterwards.
- Runs are visible in the session list; a scheduled task is not a hidden subsystem the user has to trust.
