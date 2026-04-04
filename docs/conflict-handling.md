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

The current MVP starts that logging surface through plugin status and recent sync log entries. Offline op replay and conflict-copy materialization are still planned work.
