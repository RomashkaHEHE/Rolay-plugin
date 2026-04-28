# Rolay Debug Playbook

This file is a fast triage guide for common runtime failures.

## First Files To Inspect

- `.obsidian/plugins/rolay/data.json`
- `.obsidian/plugins/rolay/rolay-sync.log`

`rolay-sync.log` is intentionally short-lived: the plugin removes lines older than 48 hours and also caps the file to a compact recent tail when tracing is noisy.

Those two files usually tell you:

- whether persisted state is correct
- whether the plugin forgot a room, or only failed to render it
- whether a snapshot, SSE, CRDT, or blob step failed first

## Common Symptoms

### Room folder looks forgotten after restart

Check:

1. `settings.roomBindings` in `data.json`
2. `rooms/info` and `startup/info` lines in `rolay-sync.log`
3. whether startup logs show deferred/staggered room resume after workspace layout readiness
4. [src/main.ts](../src/main.ts) room recovery helpers:
   - `getDownloadedRooms`
   - `getDownloadedFolderName`
   - `reconcileLocalRoomFolders`

### Cursor jitters when text is inserted before it

Check:

1. [src/realtime/shared-presence.ts](../src/realtime/shared-presence.ts)
2. whether the cursor is being remapped by CodeMirror transaction changes and then redundantly re-rendered from an unchanged awareness snapshot

Key functions:

- `setRemotePresenceDecorations`
- `getPresenceSignature`
- `recordMappedRemotePresence`
- `stabilizeIncomingPresences`

Current expectation:

- CodeMirror remaps the already-rendered remote cursor immediately through local transactions
- the plugin mirrors that remap in per-view state
- short-lived stale awareness payloads that would move the cursor backwards are rejected inside a small stabilization window

### Local viewport jumps to the bottom while someone else edits

Check:

1. [src/realtime/crdt-session.ts](../src/realtime/crdt-session.ts)
2. [src/utils/text-diff.ts](../src/utils/text-diff.ts)

Key functions:

- `syncRemoteIntoOpenEditors`
- `applyTextPatchToEditor`

Current expectation:

- remote markdown patches should preserve the local editor viewport
- incoming CRDT text should update the document without forcing a reveal/scroll jump

### Viewer chips or explorer badges are wrong

Check:

1. `presence/info` and `presence/error` lines in the log
2. whether room note presence SSE connected successfully
3. [src/main.ts](../src/main.ts):
   - `applyNotePresenceSnapshot`
   - `applyNotePresenceUpdate`
   - `renderNotePresenceChipsForView`
   - `getExplorerNotePresenceBadges`
   - minimal-visible-parent explorer aggregation logic for note presence
4. [src/realtime/crdt-session.ts](../src/realtime/crdt-session.ts):
   - `publishLocalViewerPresence`
   - `clearLocalPresence`
5. [src/sync/note-presence-stream.ts](../src/sync/note-presence-stream.ts)

### Binary file path appears but bytes do not

Check:

1. `blob/info` and `blob/error` lines in the log
2. `binaryCache` in `data.json`
3. [src/main.ts](../src/main.ts):
   - `syncBinaryEntriesFromSnapshot`
   - `ensureBinaryEntryDownloaded`
   - `applyDownloadedBinary`
4. [src/api/client.ts](../src/api/client.ts):
   - `createBlobDownloadTicket`
   - `downloadBlobFromUrl`

Useful expectation:

- a remote binary placeholder should immediately count as `loading` in the explorer
- any red downloading/protected explorer path or yellow uploading path should have a `0-100%` badge. Active binary transfers use byte progress, remote placeholders start at `0%`, markdown locks use bootstrap metadata/cache state, and folders roll child progress up.

### Disconnect does not stop room activity

Check:

1. [src/main.ts](../src/main.ts):
   - `disconnectRoom`
   - `stopRoomEventStream`
   - `cancelRoomBinaryTransfers`
   - `isRoomSyncActive`
2. [src/obsidian/file-bridge.ts](../src/obsidian/file-bridge.ts):
   - `applySnapshot`

Useful expectation:

- disconnect affects only the selected room/workspace
- active binary uploads/downloads for that workspace are aborted
- late snapshot/bootstrap/download work should not materialize files after room status becomes `stopped`

### Binary transfer restarts from zero after app restart

Check:

1. whether `binaryTransfers` in `data.json` still contains the task
2. whether `pendingBinaryWrites` in `data.json` still points at the local upload file
3. whether the `.part` file exists for downloads in `.obsidian/plugins/rolay/transfers/`
3. [src/main.ts](../src/main.ts):
   - `rememberPendingBinaryWrite`
   - `reconcilePendingBinaryWrites`
   - `syncBinaryEntriesFromSnapshot`

Current expectation:

- uploads resume from the server-reported offset in `upload-ticket.uploadedBytes`
- downloads resume from the local `.part` file size plus ranged `GET /blob/content`
- the final vault file should only be written after full hash verification succeeds

### Markdown opens but live sync is weird

Check:

1. `crdt/info` lines in the log
2. duplicate `connected/opened` lines for the same file
3. [src/realtime/crdt-session.ts](../src/realtime/crdt-session.ts):
   - `bindToFile`
   - `runSessionOperation`
   - `syncRemoteIntoOpenEditors`
   - `updateLocalPresence`

### Settings UI looks stale

Check:

1. `settings-sse/info` and `settings-sse/error` lines in the log
2. [src/main.ts](../src/main.ts):
   - `activateSettingsPanelRealtime`
   - `loadSettingsPanelSnapshot`
3. [src/sync/settings-stream.ts](../src/sync/settings-stream.ts)

## Good Debugging Order

1. Reproduce once.
2. Read the latest `rolay-sync.log` tail.
3. Identify the first failure, not the loudest later symptom.
4. Confirm whether persisted plugin data matches the expected state.
5. Only then patch the subsystem that actually failed first.
