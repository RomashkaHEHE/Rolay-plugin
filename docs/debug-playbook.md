# Rolay Debug Playbook

This file is a fast triage guide for common runtime failures.

## First Files To Inspect

- `.obsidian/plugins/rolay/data.json`
- `.obsidian/plugins/rolay/rolay-sync.log`

Those two files usually tell you:

- whether persisted state is correct
- whether the plugin forgot a room, or only failed to render it
- whether a snapshot, SSE, CRDT, or blob step failed first

## Common Symptoms

### Room folder looks forgotten after restart

Check:

1. `settings.roomBindings` in `data.json`
2. `rooms/info` and `startup/info` lines in `rolay-sync.log`
3. [src/main.ts](../src/main.ts) room recovery helpers:
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

### Viewer chips or explorer badges are wrong

Check:

1. `presence/info` and `presence/error` lines in the log
2. whether room note presence SSE connected successfully
3. [src/main.ts](../src/main.ts):
   - `applyNotePresenceSnapshot`
   - `applyNotePresenceUpdate`
   - `renderNotePresenceChipsForView`
   - `getExplorerNotePresenceBadges`
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
