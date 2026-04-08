# Rolay Server Contract For The Plugin

This repository keeps the essential server handoff context in normal project docs so plugin work does not depend on a temporary copied folder.

## Data Modes

Rolay `v1` splits sync into three layers:

1. Room management
   Human-facing room list, invite lifecycle, and membership/admin management.
2. Room tree
   Server-authoritative folder/file index under `/v1/workspaces/{workspaceId}/...`.
3. Markdown content
   Yjs document synced over Hocuspocus-compatible websocket transport.
4. Settings/admin realtime
   Dedicated SSE stream for profile, room-list, invite, and admin management UI.

Binary content remains blob-based and is addressed by `sha256`.

## Identity Model

- The human-facing object is a room.
- Stable room identity is `workspace.id`.
- Room names may repeat and must never be used as a local state key.
- Users have a global role: `admin`, `writer`, `reader`.
- Room members have a room-local role: `owner`, `member`.

The plugin therefore stores:

- user-level permissions from `user.isAdmin` and `user.globalRole`
- per-room local binding from `workspace.id -> folderName`
- per-room sync state from `workspace.id -> snapshot cursor / snapshot timestamp`
- room-local capabilities from `room.membershipRole`

## Startup Flow

Expected client order:

1. Authenticate with `login` or `refresh`.
2. Fetch `GET /v1/auth/me`.
3. Load room list from `GET /v1/rooms`.
4. When settings open, fetch the settings/admin snapshot by REST and then open `GET /v1/events/settings`.
5. Resume sync only for rooms that were previously downloaded.
6. For each downloaded room:
   fetch `GET /v1/workspaces/{workspaceId}/tree`
7. For each downloaded room:
   open `GET /v1/workspaces/{workspaceId}/events?cursor=...`
8. For opened markdown files inside downloaded room folders:
   request a `crdt-token` and connect a Yjs provider.

## REST Endpoints Used By The MVP

### Auth

- `POST /v1/auth/login`
- `POST /v1/auth/refresh`
- `GET /v1/auth/me`
- `PATCH /v1/auth/me/profile`

`login` returns `accessToken`, `refreshToken`, and `user`. `refresh` rotates only tokens, so the plugin follows it with `GET /v1/auth/me` when rebuilding authoritative user state.

### Room Management

- `GET /v1/rooms`
- `POST /v1/rooms`
- `POST /v1/rooms/join`
- `GET /v1/rooms/{workspaceId}/invite`
- `PATCH /v1/rooms/{workspaceId}/invite`
- `POST /v1/rooms/{workspaceId}/invite/regenerate`

Important invite rules:

- a room has one current invite key
- enable/disable does not rotate the key
- regenerate rotates the key and invalidates the old one

### Admin Management

- `GET /v1/admin/users`
- `POST /v1/admin/users`
- `DELETE /v1/admin/users/{userId}`
- `GET /v1/admin/workspaces`
- `GET /v1/admin/workspaces/{workspaceId}/members`
- `POST /v1/admin/workspaces/{workspaceId}/members`
- `DELETE /v1/admin/workspaces/{workspaceId}`

### Tree Snapshot

- `GET /v1/workspaces/{workspaceId}/tree`

The response includes:

- `workspace`
- `cursor`
- `entries[]`

Each entry has stable identity separate from its path:

- `id`
- `path`
- `kind`
- `contentMode`
- `entryVersion`
- `deleted`
- `updatedAt`

### Tree Events

- `GET /v1/workspaces/{workspaceId}/events?cursor=...`

The event stream is ordered per room/workspace. Event IDs increase monotonically and the client resumes from the last applied ID for that `workspace.id`.

### Settings/Admin Events

- `GET /v1/events/settings`

The settings stream is distinct from room tree SSE. The plugin uses it only after an initial REST snapshot for the currently open settings UI.

Important behavior:

- resume is supported through `Last-Event-ID` or `cursor`
- opening without a cursor yields a synthetic `stream.ready` event whose ID becomes the next resume point
- `ping` is only keepalive
- payloads are snapshot-like and keyed by stable IDs

The plugin currently reacts to:

- `auth.me.updated`
- `room.created`
- `room.updated`
- `room.deleted`
- `room.membership.changed`
- `room.invite.updated`
- `admin.user.created`
- `admin.user.updated`
- `admin.user.deleted`
- `admin.room.members.updated`

### Markdown CRDT Bootstrap

- `POST /v1/workspaces/{workspaceId}/markdown/bootstrap`

The room-level bootstrap response provides:

- `workspaceId`
- `encoding`
- `includesState`
- `documentCount`
- `totalStateBytes`
- `totalEncodedBytes`
- `documents[]`

Each bootstrap document contains:

- `entryId`
- `docId`
- `stateBytes`
- `encodedBytes`
- optional `state` (`base64` encoded Yjs state)

The plugin uses this endpoint in two phases:

1. `includeState=false`
   metadata-only probe to learn exact byte counts for room preload progress.
2. `includeState=true`
   batched Yjs-state download that fills local CRDT cache and safe local markdown hydration.

This endpoint is used only for cold start / offline-safe bootstrap of markdown CRDT cache. It does not replace live websocket sync.

### Markdown CRDT Realtime

- `POST /v1/files/{entryId}/crdt-token`

The response provides:

- `entryId`
- `docId`
- `provider`
- `wsUrl`
- `token`
- `expiresAt`

The websocket transport is standard Yjs-compatible transport, not a custom binary protocol. The plugin first fills local CRDT cache via `/markdown/bootstrap`, then still uses `crdt-token` for live collaborative editing.

## Tree Mutation Rules

Tree writes are sent through:

- `POST /v1/workspaces/{workspaceId}/ops/batch`

Every operation must include:

- `opId`
- `type`

Race-sensitive operations should include `preconditions`, especially `entryVersion` and current `path`.

Supported server operation types:

- `create_folder`
- `create_markdown`
- `create_binary_placeholder`
- `rename_entry`
- `move_entry`
- `delete_entry`
- `restore_entry`
- `commit_blob_revision`

## Implementation Assumptions In This Repo

- The plugin uses the fixed live server URL `http://46.16.36.87:3000`.
- The plugin keeps local state around `workspace.id`, not room name.
- Each room has its own local folder binding chosen by the user. The default folder name is the room name.
- Local room files are projected under `syncRoot/<room-folder-name>/...`.
- A room is not materialized locally until the user explicitly downloads it.
- Download is rejected if the target folder already exists in the vault.
- Multiple downloaded rooms are live-synced in parallel.
- Device label and startup auto-connect behavior are fixed by the plugin instead of being user-configurable.
- Markdown bootstrap is kept separate from `/tree`; the plugin fetches tree metadata first, then byte metadata from `/markdown/bootstrap`, and finally pulls Yjs state in batches through the same endpoint.
- SSE payload shape is treated defensively. The plugin advances cursor state and refreshes the authoritative tree snapshot when tree/blob events arrive instead of assuming a fully materialized `FileEntry` in every SSE payload.
