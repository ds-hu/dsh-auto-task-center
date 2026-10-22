# 3. Tasks live in a plugin-owned JSON file

Date: 2026-10-22
Status: accepted

## Context

DSH offers `storages` (a host service for plugin state), the profile's `cordis.patch.yml` config, and
plain files. The first two are the idiomatic choices; both leave state that outlives the plugin, in a
place the user did not choose, and both complicate an honest "uninstall leaves no residue" story.

## Decision

The plugin owns `$DSH_HOME/task-center/tasks.json`, written by `lib/store.js` with a temp-file-then-rename
sequence. The directory is created lazily, on the first write.

## Consequences

- Uninstalling is a file removal the user can do themselves; `dsh-auto-task-center purge` exists only to
  make it comfortable.
- Nothing about the plugin is stored in the profile config, so a botched removal cannot break the profile.
- The store is a single writer inside one process. A second DSH instance pointed at the same home would
  race on the file — acceptable, because the profile (and its home) is per-user and per-process in
  practice, and the alternative would be a lock file that itself becomes residue.
- Atomic rename means a crash mid-write costs the new record, never the file.
