# 8. Model and permission come from the Host's own switches, before the first turn

Date: 2026-10-23
Status: accepted

## Context

A scheduled run makes decisions while nobody is watching: which model pays for it, and how much of the
machine it may touch. Leaving both to the deployment default is wrong for the cases this plugin exists
for — a nightly digest wants the cheap model, a refactor wants the deep one; a read-only report should not
be able to `rm` anything, and a release job may need full access.

Three questions had to be answered.

1. **Where does the value live?** `SessionCreateRequest` carries only `workspaceId`, `cwd`, `sessionId`
   and `agentPreset`. There is no `model` and no `permission` field to fill in at create time.
2. **Which API applies it?** Model selection exists as `sessionController.selectModel`, a durable
   projection write. Permission presets are a product-level bundle (`ctx.permissionPresets`) whose write
   path is the `/permission` command, not a plain setter — the service's `set()` wants a live `Session`
   object.
3. **What happens when the chosen model or preset disappears?** A stored task must not become unloadable
   or silently run as something else.

## Decision

Apply both **after** the session exists and **before** its first prompt, through the Host's own surfaces:

- model → `sessionController.selectModel({ sessionId, provider, model, reasoningEffort? })`, which writes
  the durable `model/selection` event, so the whole session runs on it rather than one request;
- permission → `commands.execute(agent, '/permission <name>', [])`, the same command the composer runs, so
  validation, the `permission/preset` + `sandbox/mode` + `approval/policy` events and the approval-policy
  write-through all belong to the Host instead of being re-implemented here.

The stored shape follows what the Host accepts: `model` is a `{ provider, model }` pair from the catalog
(never a display label), `permission` is a preset **key**. Ordering is the point of the design: the
switches happen before `prompt`, so no turn ever runs on the previous model or in the wrong sandbox.

Both are optional and **new-session only**. A `kind: 'session'` target rejects them with
`target/model-session`: reconfiguring a conversation a person is using is a surprise, not a feature.

Failure is explicit. An unroutable model records `model-unavailable`; a preset the profile does not offer
records `permission-invalid` (carrying the Host's "available: …" text); a profile without a command
service records `commands-unavailable`. Nothing falls back to the default silently — the run is delivered
not at all, and the record says why.

Validation is deliberately split: the *shape* is checked when the task is saved, the *existence* when the
run fires. A profile that renames or removes a preset must not make stored tasks fail to load.

## Consequences

- The panel offers the pickers only when the Host answers for them (`capabilities.models`,
  `capabilities.permissions`), and shows the deployment default as the empty option — so a profile with no
  model catalog (no credentials, a minimal composition) looks exactly as it did before this feature.
- `GET /state` now carries both catalogs. The model catalog is cached for a minute because asking it
  reaches provider adapters; the permission catalog is read per request because it is process state.
- The panel localises the three preset keys the product ships and shows anything else under its configured
  name, so a custom preset works without a client change.
- The run record and the target summary both name what was used (`using deepseek-v4-pro as read-only`), so
  the history, the panel and the `task_center` tool agree, and an audit of "which model did this cost come
  from" needs no second query.
- `reasoningEffort` is accepted but not surfaced in the panel: the Host fills a default when it is omitted,
  and exposing the effort ladder is a UI decision for later, not a field to guess at now.
