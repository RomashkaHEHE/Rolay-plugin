# Primary Vault Integrity Audit

Status: IN_PROGRESS
Priority: High
Last updated: 2026-07-28

## Goal

Prove that a real primary-vault import converges without lost or altered content, then fix any
client defect exposed by the workload.

## Current Understanding

- The audited room uses the released `1.2.17` desktop client and the production HTTPS server.
- Persisted Markdown create/merge and binary transfer/write queues converged to zero without errors,
  conflicts, authentication failures, or hash mismatches.
- Local and server trees match exactly: 32 folders, 113 Markdown notes, and 34 binary files.
- All 113 local Markdown texts match both production bootstrap Yjs state and persisted CRDT cache.
- All 34 binary files match production metadata and freshly downloaded server bytes by size and
  SHA-256.
- Markdown hydration leaves locally diverged closed files untouched unless their content still
  matches the previous cached state.
- The audit exposed a separate performance defect: the full state of every closed Markdown note was
  downloaded about every seven seconds even when no state changed.
- A later local-log audit exposed a binary idempotency defect in the same import: all 34 binary
  entries received two identical `commit_blob_revision` operations. Paths and bytes stayed correct,
  but the room cursor advanced by 68 blob commits and every binary entry reached version `2`.
- Root cause: snapshot reconciliation replayed durable pending writes while their original upload
  workers were still active, and the shared queue interpreted that replay as a new local edit.

## Relevant Files

- [../../src/main.ts](../../src/main.ts)
- [../../README.md](../../README.md)
- [../../docs/debug-playbook.md](../../docs/debug-playbook.md)
- Runtime `data.json` and `rolay-sync.log` in the audited vault

## Progress Notes

- 2026-07-28: Verified exact path/kind equality for all 179 server tree entries.
- 2026-07-28: Reconstructed every production Markdown Yjs state and compared it with local disk and
  cache; no text mismatch was found.
- 2026-07-28: Downloaded all 34 binary files back from production and verified 36,086,770 bytes
  against local files and server SHA-256 metadata.
- 2026-07-28: Changed post-snapshot fallback settling from 1.2 seconds to 15 seconds, steady
  closed-note reconciliation from 5 seconds to 60 seconds, and stopped counting unchanged files as
  locally hydrated writes.
- 2026-07-28: Re-audited the installed `1.2.20` state. The production tree has exactly 179 active
  entries with no duplicate/missing/extra paths; all 113 Markdown texts and normalized Yjs states
  match server, cache, and disk; all 34 binary files match server and cache by size and SHA-256; all
  pending queues and transfer records are empty.
- 2026-07-28: Prepared plugin `1.2.21`: made pending-write reconciliation passive for a path with an
  active upload, added a committed `hash + size + MIME` client no-op, and guaranteed worker tokens
  are released after failure so later reconciliation can retry.
- 2026-07-28: Added the server companion guard: an identical blob revision with valid preconditions
  returns `applied` without another version increment or SSE event. Plugin check/build and all 34
  server integration tests pass.
- 2026-07-28: Deployed the server guard from commit `c70836b`; GitHub Actions deploy run
  `30386327315` completed successfully and production `/ready` returned `200`.
- 2026-07-28: Released plugin `1.2.21` from commit `535c1ee`; GitHub Actions run `30386634559`
  passed, all standalone/archive assets match the tag, and the production updater reports
  `1.2.21` with byte-verified runtime files.

## Open Questions / Risks

- The audited vault's separate Git history is old and currently has many uncommitted moves/changes.
  Rolay now provides a verified second copy, but it should not be treated as the only backup.
- The one-minute closed-note fallback preserves eventual disk convergence. Open notes remain
  realtime, and opening a stale closed note still joins the authoritative CRDT session.

## Next Steps

1. Run a small controlled binary import and confirm one placeholder plus one blob commit per file,
   with no rerun after `local-op` snapshots.
2. Move this task to `WATCH` after runtime verification.

## Exit Criteria

- Local/server path sets and all Markdown/binary content checks pass.
- No pending operation or transfer remains after import.
- Quiet rooms no longer perform a full Markdown state download every few seconds.
- Active-note realtime, snapshot hydration, local-divergence protection, and Disconnect semantics
  remain unchanged.
