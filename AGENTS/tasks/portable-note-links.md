# Portable Note Links

Status: WATCH
Priority: High
Last updated: 2026-11-15

## Goal

Reconcile Obsidian link rewrites in closed Markdown notes for any target file type, preserving
local content and concurrent remote edits. Room folder names must not leak into shared paths.

## Current Understanding

Vault modify events currently ignore Markdown. Five Lessons notes diverged only in embed targets.
Compare resolved room entry IDs, not filenames or extensions. Outside-room, ambiguous, deleted,
or genuinely different targets must remain protected rather than be silently substituted.

## Relevant Files

- src/main.ts
- src/settings/data.ts
- src/realtime/crdt-session.ts
- src/sync/markdown-links.ts
- tests/markdown-links.test.ts

## Next Steps

- Companion server commit 89758fe is pushed; verify deployment before publishing client 1.2.28.
- Release/install 1.2.28 and verify in Obsidian. The release includes the local-change indicators.
- Verify four audited Lessons notes auto-reconcile; the fifth remains protected because an embed
  resolves outside the room. Read-only planning against current room tree confirmed this split.

## Implementation And Verification

- Wiki and inline Markdown link destination spans are reconciled only when all changed targets
  resolve to the same room entry IDs. Labels, anchors, surrounding prose, code, and comments are
  preserved; unrelated edits and ambiguous/outside targets are rejected. Reference-style links
  are conservatively preserved, not automatically rewritten.
- Portable targets use explicit source-relative ./ or ../ paths. Observed local rename/folder
  move and snapshot ID/path changes supply old-path aliases for the same target ID.
- Closed-note modify events and preload divergence detection schedule reconciliation; active
  editor CRDT remains responsible for open-note editing.
- Original text/base state are saved under .obsidian/plugins/rolay/link-backups as content-addressed
  JSON files before rewriting. These are recovery copies, not logs, and are not age-purged.
- pendingMarkdownMerges.linkRewrite stores its own encoded Yjs update and original text; it is
  independent of the refreshed remote cache and survives settings normalization/restart.
- Precise destination-only Yjs edits preserve unrelated concurrent changes. Server bootstrap must
  include the pending state before an atomic local compare-and-write and queue cleanup.
- Per-entry work deduplicates; room generation/path/identity checks reject stale callbacks.
  Disconnect aborts link-merge providers. A protected divergent note is not newly bound to CRDT
  until reconciliation, avoiding remote editor hydration overwriting its preserved local text.
- Client 37 tests and TypeScript pass, including arbitrary file types, encoded names, ambiguity,
  rename aliases, room escape, durable replay, concurrent edits, and duplicate update replay.
- Companion server source-relative lookup tests, web typecheck, and web build pass. End-to-end
  Obsidian runtime checks remain for rollout; changes are not published or installed yet.

## Exit Criteria

Equivalent same-room wiki/Markdown links reconcile for arbitrary file types; unresolved changes
survive. Retried updates are idempotent and cannot replace unrelated concurrent text.
