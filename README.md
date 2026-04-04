# Rolay Obsidian Plugin

Obsidian plugin for connecting a vault to a Rolay server with room-aware auth, management, and sync.

The current MVP is built against the live Rolay `v1` contract and now follows the newer room model:

- configurable `serverUrl`
- configurable `syncRoot`
- username/password login plus refresh-token recovery
- current-user bootstrap via `GET /v1/auth/me`
- self-service `displayName` editing
- user session state with both `isAdmin` and `globalRole`
- room list, room creation, and room join by invite key
- per-room local folder binding with editable folder name
- explicit `Download room` flow before any files are materialized locally
- parallel tree snapshot and SSE sync for every downloaded room
- owner-only invite controls on each owned room
- admin-only user list, user creation, user deletion
- admin-only room list, member inspection, add-user-to-room, and room deletion
- CRDT bootstrap for markdown files through `crdt-token` and Yjs/Hocuspocus

## Current Server Contract

The plugin treats Rolay as a layered sync system:

- Room management and invite lifecycle live under `/v1/rooms`
- Admin user and room management live under `/v1/admin/...`
- Room content still syncs through `/v1/workspaces/{workspaceId}/...`
- Markdown realtime still uses `POST /v1/files/{entryId}/crdt-token`

Important product rules reflected in the plugin:

- the main human-facing entity is a room, not the old editor/viewer workspace model
- stable identity is always `workspace.id`, never the room name
- room names may repeat
- users have a global role: `admin`, `writer`, or `reader`
- room members have a separate room-local role: `owner` or `member`
- `writer` and `admin` can create rooms; `reader` can only join
- there is no public self-registration
- room membership is gained by invite key or admin assignment
- invite enable/disable does not change the key; regenerate does
- tree sync remains server-authoritative
- markdown note content is still the only CRDT-managed content in `v1`

More detailed notes live in [docs/server-contract.md](docs/server-contract.md), [docs/room-model.md](docs/room-model.md), [docs/auth-user-management.md](docs/auth-user-management.md), and [docs/conflict-handling.md](docs/conflict-handling.md).

## Development

Install dependencies:

```bash
npm install
```

Type-check:

```bash
npm run check
```

Build once:

```bash
npm run build
```

Watch during development:

```bash
npm run dev
```

## MVP Notes

- The plugin no longer stores a single `activeRoomId`.
- Each room can be bound to its own local folder name. The default is the room name, not `workspace.id`.
- Downloading a room is explicit. Until `Download room` is pressed, no local folder is materialized for that room.
- Download is rejected if the target room folder already exists in the vault.
- Downloaded rooms sync in parallel: each downloaded room maintains its own snapshot cursor and SSE stream.
- Local room folders are projected under `syncRoot/<room-folder-name>/...`.
- Admin account creation currently supports `writer` and `reader` global roles.
- Binary blob download/upload is still future work; markdown CRDT and server-authoritative tree sync are the current focus.
- Session credentials are still stored in Obsidian plugin data for MVP speed. Hardening storage is future work.
