# Rolay Obsidian Plugin

Obsidian plugin for connecting a vault to a Rolay server with room-aware auth, management, and sync.

The current MVP is built against the live Rolay `v1` contract and now follows the newer room model:

- fixed Rolay server URL (`http://46.16.36.87:3000`)
- configurable `syncRoot`
- username/password login plus refresh-token recovery
- current-user bootstrap via `GET /v1/auth/me`
- self-service `displayName` editing
- self-service password change with session rotation
- user session state with both `isAdmin` and `globalRole`
- room list, room creation, and room join by invite key
- per-room local folder binding with editable folder name
- explicit `Install room` flow before any files are materialized locally
- parallel tree snapshot and SSE sync for every downloaded room
- owner-only invite controls on each owned room
- admin-only user list, user creation, user deletion
- admin-only room list, member inspection, add-user-to-room, and room deletion
- separate in-settings admin tab that appears only for logged-in admins
- settings/admin live updates through `GET /v1/events/settings`
- CRDT bootstrap for markdown files through `crdt-token` and Yjs/Hocuspocus
- room-level markdown bootstrap through `POST /v1/workspaces/{workspaceId}/markdown/bootstrap`
- binary/blob sync for every non-markdown file through upload/download tickets and `commit_blob_revision`

## Current Server Contract

The plugin treats Rolay as a layered sync system:

- Room management and invite lifecycle live under `/v1/rooms`
- Admin user and room management live under `/v1/admin/...`
- Room content still syncs through `/v1/workspaces/{workspaceId}/...`
- Markdown cold-start/bootstrap now uses `POST /v1/workspaces/{workspaceId}/markdown/bootstrap`
- Markdown realtime still uses `POST /v1/files/{entryId}/crdt-token`
- Settings/admin live UI updates use `GET /v1/events/settings`
- Password change lives under `PATCH /v1/auth/me/password` and rotates the active session

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
- every non-`.md` file, including `.txt`, is treated as binary/blob content

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

## Install And Update For The Group

The easiest path for your academic group is `BRAT` plus GitHub Releases.

### For End Users

1. Install the `BRAT` plugin in Obsidian.
2. Open BRAT settings and add this repository as a beta plugin.
3. Turn on BRAT auto-updates if you want new releases to arrive automatically.

After that, users usually only need BRAT to pull the next GitHub release. They do not need to manually copy `main.js`, `manifest.json`, or `styles.css`.

### For Maintainers

This repository includes a GitHub Actions release workflow that publishes BRAT-friendly assets on tagged releases.

Release steps:

1. Update the version in `manifest.json`.
2. Keep `package.json` version in sync with `manifest.json`.
3. Add the same version to `versions.json`.
4. Commit the changes.
5. Create and push a tag like `v0.1.0`.

The workflow then:

- installs dependencies
- runs `npm run check`
- runs `npm run build`
- uploads `manifest.json`, `main.js`, `styles.css`, `versions.json`
- uploads a release zip for convenience

BRAT can consume the release assets directly, so this is enough for one-click updates inside the group.

## MVP Notes

- The plugin no longer stores a single `activeRoomId`.
- The server URL, device label, and startup auto-connect behavior are fixed in the plugin instead of being user-configurable.
- Each room can be bound to its own local folder name. The default is the room name, not `workspace.id`.
- Installing a room is explicit. Until `Install` is pressed, no local folder is materialized for that room.
- Install is rejected if the target room folder already exists in the vault.
- Downloaded rooms sync in parallel: each downloaded room maintains its own snapshot cursor and SSE stream.
- Local room folders are projected under `syncRoot/<room-folder-name>/...`.
- After each authoritative room snapshot, the plugin first fetches byte metadata for room markdown bootstrap and then downloads Yjs state in HTTP batches. This keeps offline-safe cache bootstrap separate from live websocket sync and gives the UI a more honest byte-based preload progress.
- After each room connect/snapshot, the plugin preloads markdown content for the whole downloaded room in the background instead of waiting for each note to be opened one by one.
- Non-markdown files now follow a separate blob flow: initial room snapshot materializes their paths, then the plugin downloads actual bytes through blob download tickets and keeps them updated from authoritative room snapshots/events.
- Markdown files that are still waiting for safe preload are temporarily protected from local move/rename/delete, and the Files pane marks those notes and their parent folders in red until the room has finished loading them safely.
- Binary files that are still downloading are also marked red and protected from local move/rename/delete; binary files with a local upload in flight are marked yellow until `commit_blob_revision` publishes the new revision.
- Settings still do an initial REST snapshot on open, but further profile/rooms/invite/admin updates now come from a dedicated settings SSE stream instead of periodic polling.
- Runtime sync logs are mirrored into `.obsidian/plugins/rolay/rolay-sync.log` so support/debugging does not depend only on the in-settings log widget.
- If a locally created offline markdown note collides with a server path on reconnect, the plugin keeps both by renaming the local file to the next free name such as `file(1).md` before retrying the create.
- When a markdown file with existing local text is created or moved into a room, the plugin now turns that text into a reusable Yjs update, persists it locally, and retries CRDT merge until the remote document has absorbed it. This avoids the old "empty file first, content only after reopen" race.
- Non-markdown local creates and modifications now upload through `create_binary_placeholder -> upload-ticket -> PUT /v1/files/{entryId}/blob/uploads/{uploadId}/content -> commit_blob_revision`, with byte-based room progress and cancel support. Blob hashes are normalized to canonical `sha256:<base64>`, while legacy hex hashes are still accepted on read. The legacy raw `upload.url` is kept only as a fallback, not the main path.
- If a local binary file conflicts with an already existing remote path or with a newer incoming blob revision, the plugin renames the local file to the next free Explorer-style filename such as `file(1).pdf` so both copies survive.
- Admin account creation currently supports `writer` and `reader` global roles.
- Session credentials are still stored in Obsidian plugin data for MVP speed. Hardening storage is future work.
- Successful password changes immediately replace the stored access token, refresh token, and saved login password used by the plugin.
