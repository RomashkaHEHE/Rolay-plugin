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
- room-level markdown note presence through `GET /v1/workspaces/{workspaceId}/note-presence/events`
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
- Room-level note presence for markdown viewer chips and explorer badges uses `GET /v1/workspaces/{workspaceId}/note-presence/events`
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

## Documentation Map

Start here when entering the project without chat history:

- [AGENTS/AGENTS.md](AGENTS/AGENTS.md)
  Live agent handoff entry point. Read this first when you need project/task context without relying on prior chat history.
- [AGENTS/current-state.md](AGENTS/current-state.md)
  Current priorities, unfinished work, and recently completed changes.
- [AGENTS/context/README.md](AGENTS/context/README.md)
  Design-intent layer: why key subsystems are shaped the way they are, not only what they currently do.
- [docs/repo-map.md](docs/repo-map.md)
  Repository map, code ownership by file, and "where to look first" guidance.
- [docs/server-contract.md](docs/server-contract.md)
  The server/API contract the plugin currently targets.
- [docs/room-model.md](docs/room-model.md)
  Room identity, local folder binding rules, and role model.
- [docs/auth-user-management.md](docs/auth-user-management.md)
  Login, session refresh, password change, profile, and admin-managed accounts.
- [docs/conflict-handling.md](docs/conflict-handling.md)
  Expected conflict behavior for markdown, tree operations, and binary blobs.
- [docs/debug-playbook.md](docs/debug-playbook.md)
  Fast triage guide for the most common sync failures and where to inspect them in code.
- [docs/roadmap.md](docs/roadmap.md)
  Short list of the next substantial product/architecture steps, including resumable file transfer work.

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

1. In Obsidian, open `Settings -> Community plugins`.
2. Install the `BRAT` plugin.
3. Open `Settings -> BRAT`.
4. Use `Add Beta plugin`.
5. Paste the URL of this repository.
6. Confirm installation.
7. Turn on BRAT auto-updates if you want new releases to arrive automatically.

After that, users usually only need BRAT to pull the next GitHub release. They do not need to manually copy `main.js`, `manifest.json`, or `styles.css`.

Notes:

- If the repository is public, users usually only need the repository URL.
- If the repository is private, BRAT distribution becomes less convenient because every user needs access to that repository. For a small group, the simplest setup is usually a public repository that is just not advertised widely.

### For Maintainers

This repository includes a GitHub Actions release workflow that publishes BRAT-friendly assets on tagged releases.

Release steps:

1. Update the version in `manifest.json`.
2. Keep `package.json` version in sync with `manifest.json`.
3. Add the same version to `versions.json`.
4. Commit the changes.
5. Create and push a tag like `1.2.2`.

The workflow then:

- installs dependencies
- runs `npm run check`
- runs `npm run build`
- uploads `manifest.json`, `main.js`, `styles.css`, `versions.json`
- uploads a release zip for convenience

BRAT can consume the release assets directly, so this is enough for one-click updates inside the group.

Tag note:

- The preferred release tag format is the plain plugin version, for example `1.2.2`.
- Legacy tags with a `v` prefix, such as `v1.2.1`, are still accepted by the workflow so older release history keeps working.

## MVP Notes

- The plugin no longer stores a single `activeRoomId`.
- The server URL, device label, and startup auto-connect behavior are fixed in the plugin instead of being user-configurable.
- Each room can be bound to its own local folder name. The default is the room name, not `workspace.id`.
- Installing a room is explicit. Until `Install` is pressed, no local folder is materialized for that room.
- Install is rejected if the target room folder already exists in the vault.
- Downloaded rooms sync in parallel: each downloaded room maintains its own snapshot cursor and SSE stream.
- Local room folders are projected under `syncRoot/<room-folder-name>/...`.
- The default `syncRoot` is the vault root (`/` in the settings UI), so newly installed rooms appear directly in the vault unless the user chooses a subfolder.
- After each authoritative room snapshot, the plugin first fetches byte metadata for room markdown bootstrap and then downloads Yjs state in HTTP batches. This keeps offline-safe cache bootstrap separate from live websocket sync and gives the UI a more honest byte-based preload progress.
- After each room connect/snapshot, the plugin preloads markdown content for the whole downloaded room in the background instead of waiting for each note to be opened one by one.
- Non-markdown files now follow a separate blob flow: initial room snapshot materializes their paths, then the plugin downloads actual bytes through blob download tickets and keeps them updated from authoritative room snapshots/events.
- Markdown files that are still waiting for safe preload are temporarily protected from local move/rename/delete, and the Files pane marks those notes and their parent folders in red until the room has finished loading them safely.
- Binary files that are still downloading are also marked red and protected from local move/rename/delete; binary files with a local upload in flight are marked yellow until `commit_blob_revision` publishes the new revision.
- Explorer badges now show live binary transfer percentages for active upload/download paths, with remote binary placeholders starting at `0%` the moment the file path appears.
- Settings still do an initial REST snapshot on open, but further profile/rooms/invite/admin updates now come from a dedicated settings SSE stream instead of periodic polling.
- Runtime sync logs are mirrored into `.obsidian/plugins/rolay/rolay-sync.log` so support/debugging does not depend only on the in-settings log widget.
- If a locally created offline markdown note collides with a server path on reconnect, the plugin keeps both by renaming the local file to the next free name such as `file(1).md` before retrying the create.
- When a markdown file with existing local text is created or moved into a room, the plugin now turns that text into a reusable Yjs update, persists it locally, and retries CRDT merge until the remote document has absorbed it. This avoids the old "empty file first, content only after reopen" race.
- Non-markdown local creates and modifications now upload through `create_binary_placeholder -> upload-ticket -> PUT /v1/files/{entryId}/blob/uploads/{uploadId}/content -> commit_blob_revision`, with byte-based room progress and cancel support. Blob hashes are normalized to canonical `sha256:<base64>`, while legacy hex hashes are still accepted on read. The legacy raw `upload.url` is kept only as a fallback, not the main path.
- Current binary crash recovery is replay-based, not yet true byte-offset resume: after restart the plugin can retry pending uploads/downloads from authoritative state, but resumable transfer sessions are future work and tracked in [docs/roadmap.md](docs/roadmap.md).
- If a local binary file conflicts with an already existing remote path or with a newer incoming blob revision, the plugin renames the local file to the next free Explorer-style filename such as `file(1).pdf` so both copies survive.
- Room note presence now drives two explorer surfaces: per-note badges and aggregated ancestor-folder badges inside the downloaded room root.
- Remote markdown patches preserve the local viewport while applying incoming CRDT text, so active collaboration should not yank the local reader/editor to the bottom of the document.
- Remote cursor stabilization now mirrors CodeMirror remapping locally and ignores short-lived stale backward awareness offsets, reducing the "cursor chases its true position" jitter when someone types before a stationary remote cursor.
- Admin account creation currently supports `writer` and `reader` global roles.
- Session credentials are still stored in Obsidian plugin data for MVP speed. Hardening storage is future work.
- Successful password changes immediately replace the stored access token, refresh token, and saved login password used by the plugin.
