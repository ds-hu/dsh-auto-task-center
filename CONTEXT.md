# Task Center — how we talk about it

The words this codebase uses, and what they mean here. If a term below changes meaning, change this
file in the same commit.

## Task

One saved instruction: **when** to run, **where** to deliver, **what** to say. A task is not a session
and not a shell job — it is a record that produces sessions over time. Its identity is `task-<uuid>` and
it survives DSH restarts.

A task is **enabled** or disabled, never "deleted but remembered": disabling keeps everything and only
stops the trigger.

## Trigger

The rule that decides *when*. Exactly one per task, and it is a closed set: **once** (`at`),
**interval** (`every`), **daily**, **weekly**, **cron**, **webhook**.

**Interval** is anchored — `everySeconds` counted from `anchorAt` — so an interval task does not drift
when DSH restarts. **Webhook** is the one trigger without a schedule: it is caused by an HTTP call, not
by the clock.

## Occurrence

A single instant at which a trigger fires. `nextOccurrence` answers "the first occurrence after X";
the panel shows five of them as **next runs** before anything is saved.

Wall-clock triggers are computed in the task's **time zone** (an IANA name), not the server's. That is
why a daily task still fires at 09:00 local when the server sits in another zone.

## Run

One attempt to deliver one occurrence. A run has a **result** — `ok`, `failed`, `skipped`, `missed` —
and a stable **code** the UI localises. Runs are recorded in a task's **history**, newest first, capped
at fifty.

`missed` is not `skipped`: *skipped* means several occurrences passed while DSH was closed and became one
record; *missed* is the single record written for that gap. The panel shows both as 已跳过 because the
user-visible outcome is identical — nothing was delivered.

## Target

Where a run delivers. Two kinds only:

- **new session** — in a chosen workspace (by id, or by path when the id is gone), with a chosen agent
  preset, optionally in a **fresh worktree**;
- **existing session** — a session id that must still resolve when the run fires.

A target that no longer resolves is a **failure**, not a silent no-op: the record says why, and the task
keeps its schedule so it recovers on its own once the target is back.

## Message

The text a run delivers, up to 16 KiB. It always becomes a **user message** in the target session, which
is what makes `/goal` and `/skill-name` work inside it.

**Payload** is the HTTP request body of a webhook run. The placeholder `{{payload}}` in the message is
always replaced — with the body for a webhook run, with nothing for a timed run.

**Goal mode** changes the delivery mechanism, not the message: the text is handed to `/goal` instead of
being sent as a message, so the turn runs autonomously towards that objective.

## Worktree target

A new-session target that asks for a **fresh worktree per run**: DSH's `dsh-better-workspaces` plugin makes
a directory and a branch for this run only, and the session opens there. **Base** is the branch it branches
off — a name, resolved when the run fires, not a pinned commit.

A worktree target that cannot be honoured is a **failure** (`worktree-unavailable`), never a fallback to the
workspace checkout: the point of the target is that the agent does not edit what a person has open.

## Webhook

A trigger with an address instead of a schedule: `/task-center/hook/<task>/<secret>`. The **secret** is
the only credential; **rotating** it invalidates the previous URL immediately.

## Needs attention

A task-level flag the scheduler sets after a failure, cleared by the next successful run. It means *this
task is failing and you should look*, and it is what the panel's **需处理 / Needs attention** filter
selects.

## Delivery

The act of turning a run into a message in a session — resolving the target, creating a session when
needed, substituting the payload, and prompting. Delivery is what can fail; the schedule never does.

## Preset

An agent configuration: the model-facing tools and instructions for one session. **任务管理** is the
preset this plugin ships — `standard` without the built-in reminder tools, plus `task_center`.

A preset is *not* a task template: it changes how the agent in a delivered session behaves, not when or
where the task runs.

## Panel

The right-sidebar tab, and the only surface where tasks are edited by hand. The **list view** shows every
task with its state; the **detail view** edits one, in five collapsible sections — basics, trigger,
delivery, webhook, run history.
