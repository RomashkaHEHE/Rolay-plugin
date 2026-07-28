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

Start mobile/network triage with `platform/info`, `lifecycle/info`, and the relevant `sse`,
`settings-sse`, `presence`, `crdt`, or `blob-trace` lines. The startup platform line records the
platform, runtime origin, HTTPS authority, expected transport chain, download concurrency, and upload chunk size;
each SSE open records its actual `node-http(s)` or `fetch` transport without logging credentials.

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

### Android resume or network switching does not recover live state

Check:

1. the startup `platform/info` line says `platform=android` and `server=https://rolay.ru`
2. `lifecycle/info` shows `mobile-resume-*`, `mobile-pageshow`, or `network-online`
3. each active SSE scope logs `Restarting ...` followed by `transport=fetch`
4. `crdt/info` shows the background transition and active-note reconnect
5. [src/main.ts](../src/main.ts):
   - `handleMobileVisibilityChange`
   - `scheduleLiveTransportRecovery`
   - `recoverLiveTransports`
6. [src/sync/event-stream.ts](../src/sync/event-stream.ts), [src/sync/settings-stream.ts](../src/sync/settings-stream.ts), and [src/sync/note-presence-stream.ts](../src/sync/note-presence-stream.ts):
   - `reconnectNow`
   - generation guards around late stream completion

Current expectation:

- backgrounding clears active Markdown viewer presence instead of leaving a hidden Android app online
- resuming restarts only rooms that were already active
- a manually disconnected room remains stopped
- browser SSE/blob failures should be checked against the server CORS allowlist and response headers

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
   - optimistic local self-viewer merge for the active note
   - immediate explorer folder interaction refresh and mutation-observer refresh for expand/collapse state
4. [src/realtime/crdt-session.ts](../src/realtime/crdt-session.ts):
   - `publishLocalViewerPresence`
   - `clearLocalPresence`
5. [src/sync/note-presence-stream.ts](../src/sync/note-presence-stream.ts)

Useful expectation:

- expanding or collapsing a folder should move presence/anonymous/transfer badges to the new minimal visible parent on the next animation frame, not after the slower sync debounce
- opening a room markdown note should show the current user immediately, even before the room-level note-presence SSE echoes the local awareness state

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
4. [src/main.ts](../src/main.ts):
   - `rememberPendingBinaryWrite`
   - `reconcilePendingBinaryWrites`
   - `syncBinaryEntriesFromSnapshot`

Current expectation:

- uploads resume from the server-reported offset in `upload-ticket.uploadedBytes`
- downloads resume from the local `.part` file size plus ranged `GET /blob/content`
- the final vault file should only be written after full hash verification succeeds

### Many duplicate notes appear and are hard to delete

Check:

1. `pendingMarkdownCreates` and `pendingBinaryWrites` in `.obsidian/plugins/rolay/data.json`
2. `ops/error` lines containing `conflicted with an existing server path`
3. repeated log lines containing `Room is disconnected; markdown create will retry after reconnect`
4. `crdt/info` lines containing `Ignored local delete ... still loading and protected` during a bulk duplicate cleanup
5. [src/main.ts](../src/main.ts):
   - `syncMarkdownCreate`
   - `reconcilePendingMarkdownCreates`
   - `isDisconnectedPendingMarkdownCreateReplay`
   - `restoreLockedMarkdownDelete`
   - `shouldBypassLockedMarkdownDeleteRestore`
   - `PENDING_DELETE_GUARD_MS`
6. [src/obsidian/file-bridge.ts](../src/obsidian/file-bridge.ts):
   - `handleVaultCreate`
   - `shouldIgnoreVaultDeleteBeforeProtection`

Current expectation:

- stopped/disconnected room vault create events must not be persisted as future create replays
- stale disconnected pending creates should be cleared, not conflict-renamed into `(1)`, `(2)`, ... copies
- already-created server duplicates require normal connected-room delete or a one-off server cleanup; the client fix prevents new duplicate generation
- remote/suppressed delete echoes must be consumed before protected markdown delete restoration, otherwise the client can resurrect files it just deleted
- safe suffix-copy markdown duplicates with `entryVersion=0` and an active base note may bypass locked-delete restoration so bulk cleanup can send `delete_entry` instead of locally restoring them
- if new suffix-copy `tree.entry.created` events still appear after this client fix, compare server logs by `X-Rolay-Client-Version`; an outdated/missing-version client should be blocked server-side for tree mutations

### Markdown opens but live sync is weird

Check:

1. `crdt/info` lines in the log
2. duplicate `connected/opened` lines for the same file
3. [src/realtime/crdt-session.ts](../src/realtime/crdt-session.ts):
   - `bindToFile`
   - `runSessionOperation`
   - `syncRemoteIntoOpenEditors`
   - `updateLocalPresence`

### Markdown files flicker red/normal or turn red when opened

Check:

1. repeated log lines like `HTTP markdown bootstrap stored ...` immediately followed by `Preloading ... (rerun)`
2. the size of `crdtCache.entries` in `.obsidian/plugins/rolay/data.json`
3. [src/main.ts](../src/main.ts):
   - `MAX_PERSISTED_CRDT_DOCS`
   - `prunePersistedCrdtCache`
   - `shouldKeepMarkdownLocked`
   - `bootstrapRoomMarkdownCache`

Current expectation:

- persistent CRDT cache must be large enough to retain room-wide markdown preload state
- if the cache cap is too small, downloaded notes are pruned and later treated as still loading
- red markdown explorer state should only mean the note is genuinely missing/unhydrated/protected, not that its cached bootstrap state was evicted
- folder percentages during markdown preload should aggregate the whole active bootstrap target set; if folders stay at `0%` until they disappear, check `addMarkdownBootstrapVisibleProgress` and exact-vs-ancestor transfer badge aggregation
- a quiet connected room must not log a full `Refreshed N/N closed markdown document(s)` pass every
  few seconds. Snapshot bursts settle after 15 seconds and the steady fallback runs once per minute;
  open notes remain realtime through WSS.

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
