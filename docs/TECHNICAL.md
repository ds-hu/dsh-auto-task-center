# Task Center — technical notes

Everything the README deliberately leaves out. Read this before changing scheduling, storage or the
HTTP surface.

- [Shape of the plugin](#shape-of-the-plugin)
- [Data model](#data-model)
- [Scheduling](#scheduling)
- [Delivery](#delivery)
- [HTTP API](#http-api)
- [Webhook security](#webhook-security)
- [The `task_center` tool](#the-task_center-tool)
- [The 任务管理 preset](#the-任务管理-preset)
- [Lifecycle](#lifecycle)
- [Uninstall](#uninstall)
- [Testing](#testing)

---

## Shape of the plugin

One npm package ships four things. They are separate entries because a profile can enable them
independently, and because the tool half must also be mountable inside an agent preset.

| Entry | Module | Mounted by | Purpose |
|---|---|---|---|
| Host | `lib/index.js` (`dsh-auto-task-center`) | the profile patch | store, scheduler, HTTP routes |
| Tools | `lib/tools.js` (`task-center-tools`) | the agent preset | registers `task_center` |
| Client | `lib/client.js` | the web shell, via `dsh.client` | the right-sidebar tab |
| Preset | `presets/task-center.patch.yml` | the profile patch | the 任务管理 agent preset |

The two halves share one object through `lib/runtime.js`, a module-level singleton. `lib/index.js`
publishes the live store and scheduler on mount and clears them on dispose; `lib/tools.js` reads them.
That indirection exists because the tool plugin is mounted by the *preset*, not by the host plugin, so
it cannot receive the host's objects as constructor arguments.

Nothing in `lib/` imports an `@deepseek-ai/*` module. A profile install resolves only the package's own
files plus the host's Cordis peer, so a Harness import would fail at load on a user's machine. The
tool definition in `lib/tool-definition.js` is a hand-built `ToolDefinition` object for the same reason:
`defineTool` lives in a package this one cannot depend on. `test/client-smoke.mjs` enforces the rule.

## Data model

One JSON file, `$DSH_HOME/task-center/tasks.json`, wrapped by `lib/store.js`.

```
{ version: 1, tasks: { [taskId]: Task } }
```

A `Task` — everything the panel edits and everything a run needs:

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | `task-<uuid>` |
| `name` | `string` | 1–120 characters, unique enough to recognise, not enforced unique |
| `enabled` | `boolean` | a disabled task keeps its state and history |
| `trigger` | `Trigger` | exactly one per task |
| `target` | `Target` | where a run delivers |
| `message` | `{ text, goalMode }` | up to 16 KiB; `goalMode` runs it through `/goal` |
| `state` | `TaskState` | scheduler-owned, never edited by the panel |
| `history` | `RunRecord[]` | newest first, capped at 50 |
| `createdAt`, `updatedAt` | ISO 8601 | `updatedAt` doubles as the optimistic-concurrency token |

`Trigger` is a discriminated union on `kind`:

| Kind | Fields | Fires |
|---|---|---|
| `at` | `at` | once, then the task deactivates itself |
| `every` | `everySeconds` (≥ 60), `anchorAt` | at a fixed interval from the anchor |
| `daily` | `time`, `timeZone` | every day at a wall-clock time |
| `weekly` | `time`, `timeZone`, `weekdays` (1–7) | on chosen ISO weekdays |
| `cron` | `expression`, `timeZone` | five-field cron |
| `webhook` | `secret` | only when called; carries no schedule |

`Target` is either `{ kind: 'newSession', workspaceId?, cwd?, agentPreset? }` or
`{ kind: 'session', sessionId }`.

`TaskState` is what the scheduler knows: `status` (`active` / `inactive` / `finished`), `nextAt`,
`evaluatedThrough`, `lastRunAt`, `lastResult`, `consecutiveFailures`, `needsAttention`.

A `RunRecord` is `{ runId, at, result, code, detail, params?, sessionId? }`. `result` is one of
`ok` / `failed` / `skipped` / `missed`; `code` is a stable machine value the client localises, so the
text of `detail` is never parsed.

Writes are atomic: a temp file in the same directory, then `rename`. Reads that find a corrupt file
move it aside as `tasks.json.corrupt-<timestamp>` and start empty, rather than crashing the profile.

## Scheduling

`lib/engine.js` answers one question — *when does this trigger fire next after instant X* — for every
kind except `webhook`, which has no schedule. `lib/zoned.js` does the wall-clock arithmetic with
`Intl.DateTimeFormat`, so time zones and daylight saving come from the platform's tz database rather
than from a bundled copy.

Two DST rules matter and are covered by tests:

- **Spring forward** — a wall-clock time that does not exist on that date is skipped, not shifted.
- **Autumn overlap** — a wall-clock time that occurs twice fires **once**, at the first instant.

The scheduler (`lib/scheduler.js`) keeps exactly one timer, armed for the earliest `nextAt`. On each
tick it:

1. selects every enabled task whose `nextAt` has passed;
2. delivers each one, recording `ok` or `failed`;
3. recomputes the next occurrence and re-arms.

`now()` is injected, which is what makes the tests deterministic.

**Missed runs.** If the process was stopped past a task's due time, the task does not replay the
backlog. `catchUp()` writes a single `missed` record — the panel shows it as *已跳过* — and schedules
the next future occurrence. Twenty missed nightly runs produce one line, not twenty sessions.

Failures do not disable a task. It keeps its schedule, increments `consecutiveFailures`, and sets
`needsAttention` so the panel can flag it. The exception is a missing target: the run is recorded as
`failed` with the reason, and the task stays enabled so it recovers when the target comes back.

## Delivery

`lib/deliver.js` turns a task plus an optional payload into one message in one session.

- **New session** — `sessionController.create({ workspaceId | cwd, agentPreset })` then
  `sessionController.prompt(...)`. The workspace is resolved by id first and by path second, so a task
  survives a workspace being re-added.
- **Existing session** — `resolveAgent(sessionId)` proves the session still exists and can accept a
  prompt; a missing one is a delivery failure with a readable reason.
- **Message** — `renderMessage(text, payload)` always substitutes `{{payload}}`: the request body for a
  webhook run, an empty string for a timed run. The result is capped at 4000 characters, and a truncated
  body says so rather than silently losing the tail.
- **Goal mode** — instead of `prompt`, the deliverer calls `commands.execute(agent, '/goal <text>', [])`.
  That is the same path the composer uses, so the goal lifecycle, budget and driver all behave normally.

`prompt` is called with `mode: 'queue'`, so a run against a busy session waits its turn instead of
interrupting the person using it.

Slash commands work in delivered messages because `sessionController.prompt` stamps
`source: { kind: 'user', rpcId, clientTimeZone }` on the message it creates, and DSH's skill scanner only
treats such a message as a user gesture. A message injected by other means would not trigger skills.

## HTTP API

Everything is served from the profile's own web server under `/task-center`, registered as one prefix
route. Mutating routes require a JSON content type and reject a foreign `Origin`; reads are plain GETs.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/task-center/api/state` | tasks, workspaces, presets, capabilities, origin, version |
| `GET` | `/task-center/api/sessions?q=&limit=` | session rows for the target picker |
| `POST` | `/task-center/api/preview` | next five runs for an unsaved trigger |
| `POST` | `/task-center/api/tasks` | create |
| `POST` | `/task-center/api/tasks/<id>` | update, guarded by `expectedUpdatedAt` |
| `POST` | `/task-center/api/tasks/<id>/delete` | delete |
| `POST` | `/task-center/api/tasks/<id>/rotate-secret` | new webhook secret |
| `POST` | `/task-center/api/tasks/<id>/clear-history` | drop the run history |
| `ANY` | `/task-center/hook/<id>/<secret>` | fire a webhook task |

Errors are `{ ok: false, code, message }` with a stable `code` (`trigger/every-invalid`,
`target/missing`, `conflict`, …) so the panel can localise without matching English text.

An update whose `expectedUpdatedAt` no longer matches answers `409`: two tabs cannot silently overwrite
each other.

`/sessions` caches the host listing for 15 seconds. `sessionController.list()` summarises every session
directory and can take seconds on a large profile; the panel normally fills the picker from the shell's
own catalog and never calls this route.

## Webhook security

- The secret is 128 bits of `crypto.randomBytes`, hex-encoded, and lives in the task's trigger.
- Comparison is `crypto.timingSafeEqual` over SHA-256 digests, so a wrong secret leaks no timing signal.
- The secret is redacted to `***` in every API response and in the tool output. The full URL is only
  shown in the panel, where the user is already authenticated.
- Each task is limited to 60 calls per minute; the 61st answers `429`.
- A disabled task answers `409` instead of firing.
- The hook route waits up to 30 s for the delivery, then answers `202` with the run id.
- Requests go through the same origin fence as the rest of the API, but a webhook caller is by
  definition not a browser: the fence checks `Origin` only when the header is present.

## The `task_center` tool

One tool, four actions — `create`, `list`, `update`, `delete`. There is deliberately no `run` action:
firing a task is the user's decision, made in the panel or by a webhook.

`create` defaults the target to the **calling session** when the model does not name one, which is the
useful default in a conversation ("remind me here in an hour"). Schemas are plain JSON Schema, and
`assertArguments` produces readable failures (`action must be one of create, list, update, delete`).

`list` returns one line per task — name, trigger summary, target summary, next run — because a model
reading fifty records learns less than a model reading fifty lines.

## The 任务管理 preset

`presets/task-center.patch.yml` is the shipped `standard` preset with one row swapped:

```
- id: tool-schedule            - id: task-center-tools
  name: @deepseek-ai/…           name: @ds-hu/dsh-auto-task-center/tools
```

`standard` disables `tool-schedule`; this preset has neither. `test/mount-check.mjs` compares the two
files row by row, so a DSH upgrade that changes `standard` shows up as a test failure instead of silent
drift.

Agent preset names cannot be localised by the platform, so the preset is called 任务管理 in every
language. The panel shows it as such, and the built-in presets keep their official labels.

## Lifecycle

`apply(ctx)` builds the store, deliverer, scheduler and API, publishes the runtime, and registers one
prefix route. Its disposer runs in reverse: routes, scheduler, store, runtime.

- Mounting creates **nothing on disk**. The data directory is created on the first write, so a profile
  that installs and never uses the plugin stays byte-identical.
- The scheduler owns one `setTimeout`, `unref`'d so it never holds the process open, and `stop()` awaits
  any in-flight tick.
- The client registers one tab type, two slots and one `<style>` element; each registration returns its
  own disposer, and the stylesheet is removed by the effect that added it.

Disabling the plugin in the plugin manager is a live operation: the host route disappears, the tab
closes in every open window, and the stylesheet is removed.

## Uninstall

Removing the package leaves no residue in the profile: no `cordis.patch.yml` edits (the bundle owns its
row), no install scripts, no services, no scheduled work outside the plugin's own timer, no files outside
`$DSH_HOME/task-center/`.

Two honest caveats:

1. **Sessions on the 任务管理 preset cannot resume** once the preset is gone, because the preset row and
   its tools module no longer exist. Switch those sessions to another preset *before* removing the plugin.
   The panel says so under the preset field, and `dsh-auto-task-center purge` repeats it.
2. **One dead tab can remain in the browser.** DSH remembers open right-sidebar tabs in `localStorage`.
   The plugin closes its tabs on dispose, but a hard uninstall means the client bundle never loads again,
   so nothing runs to close them. The shell shows its own "无法显示此内容" placeholder in that tab; one
   click removes it. The alternative — a background process rewriting browser storage — would be worse.

To remove stored tasks as well:

```bash
dsh-auto-task-center path          # print the data directory
dsh-auto-task-center status        # what is in it
dsh-auto-task-center purge --yes   # delete it, after a realpath guard
```

`purge` refuses to run without `--yes` on a terminal and refuses any path whose basename is not
`task-center`, so a mistyped `DSH_HOME` cannot turn it into `rm -rf`.

## Testing

```bash
npm run check      # lint + unit tests + packaging audits
npm test           # unit tests only
```

| Suite | Covers |
|---|---|
| `test/core.test.mjs` | model normalisation, cron parsing, DST edges, occurrence counting |
| `test/store.test.mjs` | atomic writes, corrupt-file quarantine, concurrent updates |
| `test/scheduler.test.mjs` | arming, firing, missed runs, failure counting, DST |
| `test/api.test.mjs` | every route against a real HTTP server, origin fence, rate limit, rotation |
| `test/tool.test.mjs` | the tool contract, target defaults, secret redaction |
| `test/lifecycle.test.mjs` | mount/dispose leaves the disk untouched; the CLI's purge guards |
| `test/mount-check.mjs` | package shape, Loader row ids, preset drift against `standard` |
| `test/client-smoke.mjs` | the browser bundle evaluated against a mock context, theme-only colours |
| `test/package.mjs` | what `npm publish` would actually upload |
