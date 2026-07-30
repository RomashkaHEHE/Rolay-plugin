# Rolay Plugin Repo Map

This document is the quickest way for a new agent or developer to orient inside the plugin repository without relying on prior chat context.

## Where To Start

1. For current priorities or unfinished work, start at [AGENTS/AGENTS.md](../AGENTS/AGENTS.md).
2. Read [README.md](../README.md) for product-level behavior and supported flows.
3. Read [server-contract.md](./server-contract.md) for the current API and protocol assumptions.
4. Open [src/main.ts](../src/main.ts) to see the runtime orchestration.
5. Use the module map below to jump to the right subsystem.

## Top-Level Runtime Architecture

The plugin is split into a few strong boundaries:

- `src/main.ts`
  Main orchestrator. Owns plugin lifecycle, persisted state, room runtime state, snapshot refresh, binary/markdown preload, settings SSE, and most cross-module coordination.
- `src/api/client.ts`
  Shared authenticated HTTP and blob transport lives here. If the bug smells like request shape, auth headers, refresh handling, upload/download transport, or status-code handling, start here. Long-lived SSE lifecycle lives in `src/sync/*`.
- `src/update/plugin-updater.ts`
  Automatic non-blocking update checks/retries, semver comparison, release-file verification,
  safe-idle scheduling, staging, backup/rollback, installation, and best-effort Obsidian soft reload.
- `src/obsidian/file-bridge.ts`
  Translates authoritative room tree state into local vault files/folders and translates local vault mutations back into server operations. This is the first place to inspect echo-loops, create/rename/delete races, and "server said create, client sent create back" style bugs.
- `src/realtime/crdt-session.ts`
  One-file-at-a-time markdown CRDT sessions. Owns Yjs/Hocuspocus connection lifecycle, persisted CRDT cache, awareness publishing, editor patching, and offline session behavior.
- `src/realtime/shared-presence.ts`
  Shared remote cursor/selection rendering for CodeMirror. If the issue is cursor placement, label behavior, selection color, or cursor jitter, start here.
- `src/sync/note-presence-stream.ts`
  Room-level markdown note presence SSE. This powers viewer chips above notes and per-note explorer badges without opening every markdown document locally.
- `src/sync/snapshot-refresh.ts`
  Pure cursor coalescing and active-Markdown-tree comparison helpers used by room snapshot
  scheduling. Start here when a local operation and its SSE echo trigger redundant work.
- `src/sync/transfer-progress.ts`
  Pure byte-weighted explorer transfer aggregation. It keeps queued, active, and completed cohort
  contributions separate so sequential files cannot reset parent progress.
- `src/settings/tab.ts`
  All settings UI and navigation. Rooms view, room detail page, account page, admin page, pagination, room install button, color picker, and tooltips all live here.
- `src/settings/data.ts`
  Persisted plugin data schema and normalization. This is the place to inspect when the plugin "forgets" state after restart or when older stored data should be migrated safely.
- `src/sync/*`
  Tree SSE, settings SSE, note-presence SSE, tree store, operations queue, and local/server path mapping.
- `src/types/protocol.ts`
  TypeScript view of the current server contract.

## Module Map

### `src/main.ts`

Most important responsibilities:

- plugin load/unload
- mobile background/resume and network-online transport recovery
- persisted state bootstrap via `mergePluginData(...)`
- room install / connect / disconnect
- room snapshot refresh and room SSE startup
- markdown bootstrap and background refresh
- binary download/upload orchestration
- settings SSE lifecycle
- admin/user/room cache management

Search here for:

- `connectRoom`
- `disconnectRoom`
- `recoverLiveTransports`
- `refreshRoomSnapshot`
- `runRoomSnapshotRefresh`
- `shouldBootstrapMarkdownAfterSnapshot`
- `bootstrapRoomMarkdownCache`
- `syncBinaryEntriesFromSnapshot`
- `queueBinaryWrite`
- `reconcilePendingBinaryWrites`
- `loadRoomMembersForUi`
- `applyNotePresenceSnapshot`
- `applyNotePresenceUpdate`
- `getRoomCardStates`
- `getExplorerTransferBadges`
- `getExplorerNotePresenceBadges`

### `src/api/client.ts`

Search here for:

- `listRooms`
- `getWorkspaceTree`
- `getWorkspaceMarkdownBootstrap`
- `createCrdtToken`
- `createBlobUploadTicket`
- `uploadBlobContent`
- `createBlobDownloadTicket`
- `downloadBlobFromUrl`
- `getLatestPluginUpdate`
- `downloadPluginUpdateFile`

### `src/update/plugin-updater.ts`

What it does:

- checks the public Rolay update manifest without authentication
- installs newer releases automatically after the main runtime reports a safe idle window
- retries temporary check/download/install failures with bounded backoff
- validates exact file allowlist, semver, sizes, hashes, plugin ID, and Obsidian compatibility
- stages all files before touching the installed plugin
- keeps local backups and rolls back partial replacement
- replaces `manifest.json` last so an interrupted install cannot label old code as current
- attempts an internal Obsidian reload only when manifest refresh APIs are available

Search here for:

- `PluginUpdater`
- `checkForUpdates`
- `installAvailableUpdate`
- `downloadAndVerifyFiles`
- `replaceInstalledFiles`
- `scheduleSoftReload`

### `src/sync/note-presence-stream.ts`

What it does:

- subscribes to room-level markdown note presence SSE
- keeps reconnect logic separate from tree SSE
- exposes immediate generation-safe reconnect for app resume/network recovery
- delivers `presence.snapshot` and `note.presence.updated` events into `main.ts`

Search here for:

- `NotePresenceEventStream`
- `start`
- `connect`

### `src/sync/*`

Important files:

- `event-stream.ts`
  Room tree SSE connection, cursor resume, generation-safe reconnect/abort, transport diagnostics,
  and event parsing.
- `settings-stream.ts`
  Settings/admin SSE connection and generation-safe reconnect lifecycle.
- `operations.ts`
  Typed construction of server-authoritative tree mutation batches.
- `snapshot-refresh.ts`
  Cursor-aware snapshot request merging/coverage and active Markdown tree signatures.
- `tree-store.ts`
  In-memory authoritative entry index for one room.
- `path-mapper.ts`
  Mapping between vault paths, room folder bindings, and server paths.

Search here for:

- `WorkspaceEventStream`
- `SettingsEventStream`
- `TreeStore`
- `OperationsQueue`
- `createSnapshotRefreshRequest`
- `mergeSnapshotRefreshRequests`
- `isSnapshotRefreshCovered`
- `doesActiveMarkdownTreeMatch`
- `toServerPathForRoom`

### `src/obsidian/file-bridge.ts`

What it does:

- applies authoritative tree snapshots into local folders/files
- guards against echo-loops for remote creates/writes/renames/deletes
- interprets local vault create/modify/rename/delete events inside downloaded room folders

Search here for:

- `applySnapshot`
- `handleVaultCreate`
- `handleVaultModify`
- `handleVaultRename`
- `handleVaultDelete`
- `ensureLocalEntry`
- `writeBinaryContent`

### `src/realtime/crdt-session.ts`

What it does:

- binds the active markdown file to a Yjs document
- keeps offline CRDT cache alive across reconnects
- pushes local editor text into Yjs
- patches remote text into open editors
- publishes awareness `user + viewer + optional selection`

Search here for:

- `bindToFile`
- `handleEditorChange`
- `handleEditorSelectionChange`
- `renderRemotePresence`
- `getRemotePresence`
- `updateLocalPresence`

### `src/realtime/shared-presence.ts`

What it does:

- converts awareness states into CodeMirror decorations
- renders remote selections and cursor widgets
- manages end-of-line inline labels and hover labels
- avoids cursor jitter from redundant awareness re-renders
- mirrors CodeMirror local remapping so stale awareness offsets do not visually pull a remote cursor backwards after local edits

Search here for:

- `buildRemotePresenceDecorations`
- `setRemotePresenceDecorations`
- `recordMappedRemotePresence`
- `stabilizeIncomingPresences`
- `SharedCursorWidget`
- `getPresenceSignature`

### `src/settings/tab.ts`

What it does:

- tab navigation (`Rooms`, `Account`, `General`, `Admin`)
- room list and room detail page
- account forms
- admin lists, pagination, and detail pages
- color picker, tooltip placement, compact cards

Search here for:

- `renderRoomsView`
- `renderRoomDetailView`
- `renderAdminView`
- `renderAdminRoomDetailView`
- `renderMembersPanel`
- `renderPresenceColorControls`

### `src/settings/data.ts`

What it does:

- default settings
- persisted plugin data schema
- normalization/migration of old stored data
- color normalization
- room binding normalization

Search here for:

- `DEFAULT_SETTINGS`
- `mergePluginData`
- `normalizeRoomBindings`
- `normalizePresenceColor`

### `src/utils/*` And `src/ui/*`

- `utils/text-diff.ts`
  Minimal text patches that preserve editor viewport during remote Markdown updates.
- `utils/sha256.ts`
  Canonical `sha256:<base64>` normalization and hashing helpers.
- `utils/file-kind.ts`
  Markdown-versus-binary classification.
- `utils/base64.ts`
  Binary/base64 conversion shared by CRDT and blob payload handling.
- `ui/text-input-modal.ts`
  Shared local-folder/name prompt.
## Typical Bug Entry Points

### "Plugin forgot my room folder after restart"

Start with:

- [src/settings/data.ts](../src/settings/data.ts)
- [src/main.ts](../src/main.ts)

Look at:

- persisted `settings.roomBindings`
- `getDownloadedRooms`
- `getDownloadedFolderName`
- `reconcileLocalRoomFolders`

### "Remote cursor jitters or label behaves strangely"

Start with:

- [src/realtime/shared-presence.ts](../src/realtime/shared-presence.ts)
- [src/realtime/crdt-session.ts](../src/realtime/crdt-session.ts)

Look at:

- `setRemotePresenceDecorations`
- `getPresenceSignature`
- `SharedCursorWidget`
- awareness `selection` publication
- `recordMappedRemotePresence`
- `stabilizeIncomingPresences`

### "Local viewport jumps during active remote editing"

Start with:

- [src/realtime/crdt-session.ts](../src/realtime/crdt-session.ts)
- [src/utils/text-diff.ts](../src/utils/text-diff.ts)

Look at:

- `syncRemoteIntoOpenEditors`
- `applyTextPatchToEditor`

### "Viewer chips or explorer presence badges are wrong"

Start with:

- [src/main.ts](../src/main.ts)
- [src/sync/note-presence-stream.ts](../src/sync/note-presence-stream.ts)
- [src/realtime/crdt-session.ts](../src/realtime/crdt-session.ts)

Look at:

- `applyNotePresenceSnapshot`
- `applyNotePresenceUpdate`
- `renderNotePresenceChipsForView`
- `getExplorerNotePresenceBadges`
- folder aggregation from note path to ancestor room folders
- `publishLocalViewerPresence`

### "Markdown text only appears after reopening note"

Start with:

- [src/main.ts](../src/main.ts)
- [src/realtime/crdt-session.ts](../src/realtime/crdt-session.ts)

Look at:

- markdown bootstrap
- pending markdown merge/create replay
- `syncRemoteIntoOpenEditors`

### "Binary file exists but bytes never arrive"

Start with:

- [src/main.ts](../src/main.ts)
- [src/api/client.ts](../src/api/client.ts)
- [src/obsidian/file-bridge.ts](../src/obsidian/file-bridge.ts)

Look at:

- `syncBinaryEntriesFromSnapshot`
- `ensureBinaryEntryDownloaded`
- `applyDownloadedBinary`
- `downloadBlobFromUrl`

Useful UI clue:

- explorer progress badges are mandatory for red/yellow sync states and are derived from `binaryTransferState`, remote binary placeholders, markdown bootstrap lock metadata, and pending local upload records
- a freshly materialized remote placeholder should already show `0%` download progress before the first ticket/content request completes, and folder badges should roll up child transfer progress

Important current constraint:

- active binary transfers are persisted in `data.json` under `binaryTransfers`
- uploads resume from server-reported `uploadedBytes`
- downloads resume from `.part` files in `.obsidian/plugins/rolay/transfers/`

### "Settings/admin UI is stale or weirdly reset"

Start with:

- [src/settings/tab.ts](../src/settings/tab.ts)
- [src/main.ts](../src/main.ts)
- [src/sync/settings-stream.ts](../src/sync/settings-stream.ts)

Look at:

- `activateSettingsPanelRealtime`
- `loadSettingsPanelSnapshot`
- settings stream event application

## Logs And Runtime Data

Useful runtime artifacts:

- plugin data:
  `.obsidian/plugins/rolay/data.json`
- runtime log:
  `.obsidian/plugins/rolay/rolay-sync.log`

The runtime log is auto-trimmed: entries older than 48 hours are removed, and very noisy logs are capped to a compact recent tail.

When debugging, the log is usually the fastest way to determine whether a failure is:

- auth/session related
- tree snapshot related
- room SSE related
- markdown CRDT related
- blob upload/download related

## Safe Mental Model

If you remember only three rules, keep these:

1. `workspace.id` is the only stable room identity.
2. Tree sync is server-authoritative.
3. Only `.md` uses CRDT; everything else is binary/blob.
