# Rolay Conflict Handling Notes

These notes summarize the server-side conflict model that the plugin must respect.

## Markdown

- Concurrent markdown edits merge through Yjs.
- Offline markdown edits are expected to merge back through Yjs persistence after reconnect.
- If the original markdown file was deleted while a client still holds offline changes, the client should preserve those edits as a conflict copy instead of silently dropping them.

## File Tree

- The tree is not a CRDT.
- Rename, move, delete, and restore rely on server-side optimistic concurrency.
- If a precondition fails, the server returns conflict information and the client should refresh authoritative state before retrying.

Typical server conflict signals:

- `entry_version_mismatch`
- `path_already_exists`

## Binary Files

- Binary payloads do not merge.
- Each committed revision is identified by a new `sha256`.
- If two clients race to overwrite the same binary file, one revision becomes canonical and the other should be materialized as a separate conflict file.

## Client Expectations

When the plugin receives a conflict or ambiguous tree event, it should:

1. refresh server state
2. map the failure to a known conflict category
3. retry only when the rule is deterministic
4. keep a local sync log for debugging and user support

Current plugin behavior:

- Recent sync activity is still shown in plugin settings, but it is also mirrored into `.obsidian/plugins/rolay/rolay-sync.log`.
- Failed local markdown creates are tracked as pending work and retried on the next authoritative room refresh/connect.
- If a pending local markdown create collides with an already existing server path, the client renames the local note to the next free filename (for example `file.md` -> `file(1).md`) before retrying, so neither copy is lost.
- Markdown imports with existing local text are treated as reusable Yjs updates instead of one-shot "seed only if empty" attempts. The plugin keeps retrying that CRDT merge until it succeeds or the local file disappears.
- Binary uploads are tracked as pending work and replayed after the next authoritative room refresh/connect if the upload or commit step fails.
- If a local binary file collides with an already existing remote path, the client renames the local file to the next free Explorer-style copy name (for example `file.pdf` -> `file(1).pdf`) before retrying, so both copies survive.
- If an incoming binary blob revision would overwrite a locally diverged file, the client first keeps the local bytes as a conflict copy and then writes the authoritative remote blob into the canonical room path.
- Binary files that are still downloading are protected from local move/rename/delete, and binary uploads are cancelable so a canceled upload never reaches `commit_blob_revision`.
