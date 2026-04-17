# Rolay Plugin Repo Map

This document is the quickest way for a new agent or developer to orient inside the plugin repository without relying on prior chat context.

## Where To Start

1. Read [README.md](../README.md) for product-level behavior and supported flows.
2. Read [server-contract.md](./server-contract.md) for the current API and protocol assumptions.
3. Open [src/main.ts](../src/main.ts) to see the runtime orchestration.
4. Use the module map below to jump to the right subsystem.

## Top-Level Runtime Architecture

The plugin is split into a few strong boundaries:

- `src/main.ts`
  Main orchestrator. Owns plugin lifecycle, persisted state, room runtime state, snapshot refresh, binary/markdown preload, settings SSE, and most cross-module coordination.
- `src/api/client.ts`
  All server HTTP/SSE/blob transport calls live here. If the bug smells like request shape, auth headers, refresh handling, upload/download transport, or status-code handling, start here.
- `src/obsidian/file-bridge.ts`
  Translates authoritative room tree state into local vault files/folders and translates local vault mutations back into server operations. This is the first place to inspect echo-loops, create/rename/delete races, and "server said create, client sent create back" style bugs.
- `src/realtime/crdt-session.ts`
  One-file-at-a-time markdown CRDT sessions. Owns Yjs/Hocuspocus connection lifecycle, persisted CRDT cache, awareness publishing, editor patching, and offline session behavior.
- `src/realtime/shared-presence.ts`
  Shared remote cursor/selection rendering for CodeMirror. If the issue is cursor placement, label behavior, selection color, or cursor jitter, start here.
- `src/sync/note-presence-stream.ts`
  Room-level markdown note presence SSE. This powers viewer chips above notes and per-note explorer badges without opening every markdown document locally.
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
- `refreshRoomSnapshot`
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
- `openSettingsEventStream`

### `src/sync/note-presence-stream.ts`

What it does:

- subscribes to room-level markdown note presence SSE
- keeps reconnect logic separate from tree SSE
- delivers `presence.snapshot` and `note.presence.updated` events into `main.ts`

Search here for:

- `NotePresenceEventStream`
- `start`
- `connect`

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

- explorer progress badges are derived from `binaryTransferState`
- a freshly materialized remote placeholder should already show `0%` download progress before the first ticket/content request completes

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
