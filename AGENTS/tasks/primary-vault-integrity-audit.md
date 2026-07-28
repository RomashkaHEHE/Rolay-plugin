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

## Open Questions / Risks

- The audited vault's separate Git history is old and currently has many uncommitted moves/changes.
  Rolay now provides a verified second copy, but it should not be treated as the only backup.
- The one-minute closed-note fallback preserves eventual disk convergence. Open notes remain
  realtime, and opening a stale closed note still joins the authoritative CRDT session.

## Next Steps

1. Run typecheck/build and inspect the generated bundle.
2. Observe a runtime build long enough to confirm the tight no-op refresh loop is gone.
3. Move this task to `WATCH` after release/runtime verification.

## Exit Criteria

- Local/server path sets and all Markdown/binary content checks pass.
- No pending operation or transfer remains after import.
- Quiet rooms no longer perform a full Markdown state download every few seconds.
- Active-note realtime, snapshot hydration, local-divergence protection, and Disconnect semantics
  remain unchanged.
