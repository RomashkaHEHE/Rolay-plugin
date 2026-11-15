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

- Monitor runtime recovery and future link rewrites. Client 1.2.28 and server support are deployed.
- The remaining Lessons note has an outside-room embed and is intentionally protected; resolving
  its actual intended target is separate from the completed rollout.

## Rollout 2026-11-15

- Server image sha-89758fee2913 is live. CI 43668085336 passed; deploy workflow 43668085530 built
  the image but failed pulling unrelated MinIO from quay.io (401). Application-only compose pull
  and up --no-deps completed successfully. Public viewer bytes and /ready were verified.
- Plugin release 1.2.28 is tagged at b7d4f52; workflow 43668326462 passed. All five release assets,
  four archive members, and three production update files match raw tag blobs. Latest discovery
  reports 1.2.28.
- Main had already autonomously updated; exact release files were then verified/installed in Main
  and Lessons. Both open vaults were closed normally and reopened without force termination.
- Before manual installation, each vault's data/runtime and room Markdown files were backed up
  under .rolay-update/manual-backup-before-1.2.28-20261115 (146 Main / 125 Lessons notes).
- Runtime confirmed portable-link reconciliation for lectures 13.03, 20.03 and 27.03; all four
  previously identified physics lecture notes now match server content. Lessons has four
  link-backups. One confirmation required an idempotent retry before server persistence caught up.
- Final read-only live audit: Main 143/143 Markdown texts match, Lessons 98/99 match. The only
  remaining difference is the known outside-room embed note; pending merge/binary/error queues
  are empty. No vault note was force-replaced during manual installation.

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
- Companion server all 40 tests, typecheck, and web build pass. Client all 37 tests, typecheck,
  production build and real Obsidian reconciliation/reconnect checks pass.

## Exit Criteria

Equivalent same-room wiki/Markdown links reconcile for arbitrary file types; unresolved changes
survive. Retried updates are idempotent and cannot replace unrelated concurrent text.
