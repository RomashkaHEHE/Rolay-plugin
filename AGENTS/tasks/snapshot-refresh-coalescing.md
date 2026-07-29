# Snapshot Refresh Coalescing

Status: WATCH
Priority: High
Last updated: 2026-07-29

## Goal

Stop local tree mutations and their SSE echoes from repeatedly fetching the same tree snapshot and
downloading every closed Markdown document, without weakening cold preload, recovery, or offline
correctness.

## Current Understanding

- A real `1.2.21` PNG create plus two renames caused nine complete 113-document Markdown bootstrap
  passes in roughly 25 seconds.
- `OperationsQueue.onAfterApply` and room tree SSE independently requested snapshots for the same
  server event.
- The old scheduler treated any request arriving while a refresh was scheduled or running as an
  unconditional rerun.
- Every tree snapshot unconditionally started room-wide Markdown bootstrap, including binary-only
  mutations.
- Local operation results and SSE events expose the same durable server cursor as
  `eventSeq`/event ID, so duplicate refresh requests can be coalesced safely.
- Forced startup, lifecycle, priority-open, manual/recovery, and failed-operation reconciliation
  remain unconditional.
- Conditional cursor-backed event/successful-local-op snapshots skip Markdown bootstrap only when
  the active Markdown `entryId -> path` set is unchanged and all local persisted-cache/file checks
  are healthy.
- An active bootstrap records its exact target paths. A Markdown create, delete, rename, or parent
  folder move during loading therefore requests a rerun even if the in-memory tree was updated
  optimistically before the snapshot arrived.
- No server change is required.

## Relevant Files

- [../../src/main.ts](../../src/main.ts)
- [../../src/sync/snapshot-refresh.ts](../../src/sync/snapshot-refresh.ts)
- [../../src/sync/operations.ts](../../src/sync/operations.ts)
- [../../tests/snapshot-refresh.test.ts](../../tests/snapshot-refresh.test.ts)
- [../../tests/operations.test.ts](../../tests/operations.test.ts)
- [../../docs/debug-playbook.md](../../docs/debug-playbook.md)

## Progress Notes

- 2026-07-29: Added cursor-carrying snapshot requests, scheduled/in-flight request merging, and
  covered-cursor suppression.
- 2026-07-29: Applied conditional Markdown bootstrap policy only to SSE/local-operation snapshots;
  all existing safety/recovery callers keep the default forced policy.
- 2026-07-29: Added exact active-bootstrap target tracking to protect empty-note creation and other
  optimistic Markdown mutations during an in-flight preload.
- 2026-07-29: Preserved a requested rerun even when an in-flight bootstrap exits early after empty
  or incomplete metadata.
- 2026-07-29: Applied no-event operation results no longer request a snapshot. Conflicts/rejections
  always request forced snapshot and Markdown reconciliation, even if a malformed response includes
  an event cursor.
- 2026-07-29: Added the returned cursor to `tree/info` snapshot logs so local operation, SSE, and
  snapshot lines can be correlated directly during runtime verification.
- 2026-07-29: Added eight focused Node tests and made the release workflow run them.
- 2026-07-29: `npm run check`, all 8 tests, production build, `npm audit --omit=dev`, generated
  bundle inspection, and `git diff --check` pass.
- 2026-07-29: Prepared plugin version `1.2.22` for release.
- 2026-07-29: Published plain-semver release `1.2.22` from commit `d76c84a`. GitHub Actions run
  `30453648991` passed, all five release assets and the four-file archive match the tag, and the
  production updater reports `1.2.22` with byte-verified runtime files.

## Open Questions / Risks

- Automated tests cover request merging, cursor coverage, operation callback behavior, binary-only
  changes, and Markdown create/delete/rename/path changes.
- Real Obsidian verification is still required because scheduler timing, vault events, SSE timing,
  and HTTP bootstrap calls cannot be reproduced fully by the pure tests.
- A healthy binary-only snapshot may still fetch `/tree`; this change removes duplicate covered
  snapshots and expensive unchanged Markdown bootstrap work, not legitimate snapshots for distinct
  server events.

## Next Steps

1. Let the automatic updater install `1.2.22` in a test vault, then perform one binary create plus
   rapid renames.
2. Confirm each server cursor is fetched at most once and binary-only snapshots log skipped
   room-wide Markdown bootstrap rather than `Preloading 113 markdown document(s)`.
3. During a deliberately slowed bootstrap, create, rename, and delete a Markdown note and verify the
   target mismatch schedules exactly one safe rerun.
4. Keep this task at `WATCH` until the real runtime trace confirms both reduced traffic and complete
   Markdown convergence.

## Exit Criteria

- Local operation/SSE echoes for an already-covered cursor do not fetch another snapshot.
- Binary-only snapshots do not restart healthy Markdown bootstrap.
- Startup/recovery and every Markdown tree/cache-health change still preload when required.
- Real-vault logs show no missed file, stale cache path, red-state regression, or repeated full-room
  bootstrap burst.
