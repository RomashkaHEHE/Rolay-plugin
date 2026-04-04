# Rolay Obsidian Plugin

Obsidian plugin for connecting a vault to a Rolay server with room-aware auth, management, and sync.

The current MVP is built against the live Rolay `v1` contract and now follows the newer room model:

- fixed Rolay server URL (`http://46.16.36.87:3000`)
- configurable `syncRoot`
- username/password login plus refresh-token recovery
- current-user bootstrap via `GET /v1/auth/me`
- self-service `displayName` editing
- user session state with both `isAdmin` and `globalRole`
- room list, room creation, and room join by invite key
- per-room local folder binding with editable folder name
- explicit `Install room` flow before any files are materialized locally
- parallel tree snapshot and SSE sync for every downloaded room
- owner-only invite controls on each owned room
- admin-only user list, user creation, user deletion
- admin-only room list, member inspection, add-user-to-room, and room deletion
- separate in-settings admin tab that appears only for logged-in admins
- CRDT bootstrap for markdown files through `crdt-token` and Yjs/Hocuspocus
- room-level markdown bootstrap through `POST /v1/workspaces/{workspaceId}/markdown/bootstrap`

## Current Server Contract

The plugin treats Rolay as a layered sync system:

- Room management and invite lifecycle live under `/v1/rooms`
- Admin user and room management live under `/v1/admin/...`
- Room content still syncs through `/v1/workspaces/{workspaceId}/...`
- Markdown cold-start/bootstrap now uses `POST /v1/workspaces/{workspaceId}/markdown/bootstrap`
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
- The server URL, device label, and startup auto-connect behavior are fixed in the plugin instead of being user-configurable.
- Each room can be bound to its own local folder name. The default is the room name, not `workspace.id`.
- Installing a room is explicit. Until `Install` is pressed, no local folder is materialized for that room.
- Install is rejected if the target room folder already exists in the vault.
- Downloaded rooms sync in parallel: each downloaded room maintains its own snapshot cursor and SSE stream.
- Local room folders are projected under `syncRoot/<room-folder-name>/...`.
- After each authoritative room snapshot, the plugin bootstraps missing markdown Yjs state in one HTTP call and stores it in local CRDT cache for safer offline reopen and later merge.
- Runtime sync logs are mirrored into `.obsidian/plugins/rolay/rolay-sync.log` so support/debugging does not depend only on the in-settings log widget.
- If a locally created offline markdown note collides with a server path on reconnect, the plugin keeps both by renaming the local file to the next free name such as `file(1).md` before retrying the create.
- Admin account creation currently supports `writer` and `reader` global roles.
- Binary blob download/upload is still future work; markdown CRDT and server-authoritative tree sync are the current focus.
- Session credentials are still stored in Obsidian plugin data for MVP speed. Hardening storage is future work.
