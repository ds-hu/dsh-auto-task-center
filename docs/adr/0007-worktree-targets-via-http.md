# 7. Worktree targets go through the other plugin's HTTP surface

Date: 2026-10-23
Status: accepted

## Context

`dsh-better-workspaces` already creates and registers git worktrees, and a scheduled agent run is exactly
the kind of work that should happen in one: unattended, possibly long, and not allowed to dirty the
checkout a person has open in another window.

It publishes **no Cordis service** — its own patch file says so — and only mounts HTTP routes under
`/better-workspaces/api`. Task Center cannot import it either: the two packages ship independently, and a
hard dependency would break every profile that installs only one of them.

The question was not *whether* to integrate but *how*, and whether a task that asks for a worktree should
degrade to the main checkout when the other plugin is missing.

## Decision

Integrate over loopback HTTP, behind a presence probe, and pick **fresh worktree per run** as the only
mode:

1. `capabilities.worktrees` is true only when `GET /better-workspaces/api/worktree-workspaces` answers
   `200 {ok:true}`; the panel hides the control otherwise.
2. A run with `target.worktree` calls `POST /worktrees {cwd, intent:'branch-off', base?, slug?}` and then
   opens the session in `workspaceId` (or `cwd`) that came back.
3. **No fallback.** If the other plugin is absent, refuses or times out, the run is recorded as `failed`
   with a stable code and the task is flagged as needing attention. It is never delivered into the
   repository root.
4. Nothing is ever deleted by this plugin; the worktree's lifecycle belongs to the plugin that made it.

## Consequences

- Installing or removing `dsh-better-workspaces` changes behaviour with **no reinstall and no restart**:
  the probe is refreshed every five minutes and the panel follows `capabilities`.
- A task survives the other plugin being removed: it keeps its stored modifier, shows a warning, and can be
  switched back to a normal workspace in one click. Its runs fail honestly in the meantime rather than
  editing the checkout.
- We inherit that plugin's fence (an `Origin`/`Host` match) and its layout (worktrees under
  `$DSH_HOME/worktrees/`), and we depend on its JSON shapes. `lib/worktree.js` is the only file that knows
  them, so an upstream change is a one-file fix, and `test/worktree.test.mjs` pins the contract with a
  stand-in server.
- Each run leaves a worktree behind. That is the cost of the guarantee: a run's changes are always
  inspectable, and nothing silently reuses them. Cleaning up is a manual (or other-plugin) action, which is
  the honest default for work that may need review.
