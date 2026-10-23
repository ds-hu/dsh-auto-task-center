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

The rule that decides *what causes a run*. Exactly one per task, and it is a closed set: **once** (`at`),
**interval** (`every`), **daily**, **weekly**, **cron**, **webhook**, **manual**.

**Interval** is anchored — `everySeconds` counted from `anchorAt` — so an interval task does not drift
when DSH restarts. **Webhook** and **manual** are the triggers without a schedule: one is caused by an
HTTP call, the other by a person or an agent asking. Both are *active* with no **next run**, which the
panel shows as *Webhook* / *Manual* instead of a countdown.

## Source

Which of the three causes produced one **run**: `schedule`, `http`, `manual`. Every trigger belongs to
exactly one source, and the source is written onto the **run record**, so a history line answers "why did
this happen" without consulting the task. Running a scheduled task by hand is a `manual` run on a task
whose trigger stays a schedule.

## Event

One firing: a source, an instant, and whatever that source carries — the request body for `http`, the actor
(`panel` or `tool`) for `manual`. Events are the only way a run starts; the scheduler, the webhook route and
the **Run now** button all build one and hand it to the same dispatcher.

## Occurrence

A single instant at which a trigger fires. `nextOccurrence` answers "the first occurrence after X";
the panel shows five of them as **next runs** before anything is saved.

Wall-clock triggers are computed in the task's **time zone** (an IANA name), not the server's. That is
why a daily task still fires at 09:00 local when the server sits in another zone.

## Run

One attempt to deliver one occurrence. A run has a **result** — `ok`, `failed`, `skipped`, `missed` —
the **source** that caused it, and a stable **code** the UI localises. Runs are recorded in a task's
**history**, newest first, capped at fifty.

`missed` is not `skipped`: *skipped* means several occurrences passed while DSH was closed and became one
record; *missed* is the single record written for that gap. The panel shows both as 已跳过 because the
user-visible outcome is identical — nothing was delivered.

## Target

Where a run delivers. Two kinds only:

- **new session** — in a chosen workspace (by id, or by path when the id is gone), with a chosen agent
  preset, optionally in a **fresh worktree**, on a chosen **model** and under a chosen **permission**;
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

## Model target

The model a **new session** runs on, stored as the pair the Host's catalog advertises —
`{ provider, model }` — not as a display label. Absent means *whatever this deployment defaults to*, which
is the common case.

The pair is checked when the run fires, not when the task is saved: a model that has become unroutable is a
**failure** (`model-unavailable`), never a quiet fallback to the default model, because the point of
pinning one is that the run costs and reasons the way you decided.

A model target may also carry a **reasoning effort** — one of the ids the model's catalog entry declares
(`off`, `low`, `high`, …). It is not a label and not a free-form value: the panel only offers what that
model advertises, and switching to a model that does not declare the chosen effort drops it rather than
sending something the provider would reject. Absent means the model's own default effort.

## Permission target

The **permission preset** a new session starts under — `read-only`, `workspace-write`,
`danger-full-access` on a stock profile, or any key the profile configures. It bundles DSH's sandbox mode
and approval policy, which is why the task stores a name and not two knobs.

It is applied through the Host's own `/permission` command, before the first turn: *仅可查看* means the run
is boxed in from its first action, not from its second. A preset the profile no longer offers is a
**failure** (`permission-invalid`), never a silent switch to a wider one.

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
