# Binary Transfer Queue Progress

Status: WATCH
Priority: High
Last updated: 2026-07-30

## Goal

Make explorer upload/download percentages represent the byte-weighted progress of the whole known
transfer queue instead of restarting at `0%` for each sequential file. Distinguish actively
transferring paths from queued paths without adding interface noise.

## Current Understanding

- `syncBinaryEntriesFromSnapshot` currently keeps its download queue in a local array. Only the file
  currently handled by a worker reaches `binaryTransferState`, so a collapsed parent can run
  `0 -> 100%` once per child.
- Completed binary transfer state is cleared immediately. Even if all queued children were
  registered up front, removing a completed child would make the aggregate denominator shrink and
  could still move the parent percentage backwards.
- Pending upload records know the affected paths and local file sizes, but they are not visually
  distinguished from a transfer that is actively using the network.
- The server already provides committed download sizes in `entry.blob.sizeBytes`; upload sizes are
  known from local bytes. No protocol change is needed.
- Progress must remain byte-weighted: two equal files contribute `50%` each, while differently sized
  files contribute according to their byte size.
- A queued download is muted red and a queued upload is muted warning/yellow. Preparing,
  transferring, and committing work remains the stronger existing color.

## Relevant Files

- [../../src/main.ts](../../src/main.ts)
- [../../src/settings/data.ts](../../src/settings/data.ts)
- [../../styles.css](../../styles.css)
- [../../README.md](../../README.md)
- [../../docs/debug-playbook.md](../../docs/debug-playbook.md)

## Progress Notes

- 2026-07-30: Traced the reset to the local-only download queue and immediate removal of completed
  transfer state. Chosen design is an explicit queued state plus a short-lived completed cohort
  contribution until no unfinished item remains.
- 2026-07-30: Added persisted transfer `queued` state and `cohortId`, registered the known download
  byte plan before starting workers, and retained completed sibling bytes until cohort drain.
- 2026-07-30: Upload pending records now create queued transfer state immediately and reuse a live
  workspace upload cohort. Queued paths are muted; preparing/transferring/committing paths retain the
  stronger existing color.
- 2026-07-30: Added a local-size check before trusting a binary cache hit so a fresh zero-byte
  placeholder cannot be mistaken for a completed non-empty blob.
- 2026-07-30: Batched initial queue registration and cohort cleanup into one UI refresh so large
  rooms do not rerender settings/explorer once per binary file.
- 2026-07-30: Completed entries contribute only while their own cohort still has unfinished work,
  so an orphaned `done` record restored after a crash cannot inflate a later unrelated queue.
- 2026-07-30: A same-path local binary write now cancels the older download before publishing its
  queued upload state. Download ticket responses, chunks, progress, finalization, failure, and
  completion are guarded by `cohortId`, so a stale worker cannot overwrite the new upload state or
  local bytes.
- 2026-07-30: `npm test` passes 12 tests, `npm run check` passes, `npm run build` succeeds, and
  `git diff --check` reports no whitespace errors.
- 2026-07-30: Prepared plugin release `1.2.23`; keep this task at `WATCH` until sequential
  multi-file upload/download behavior is exercised in a real vault.

## Open Questions / Risks

- Files with no trustworthy local binary cache are conservatively queued until their local hash is
  checked. If the hash already matches, they complete without downloading and leave the queue.
- Automated coverage verifies aggregate arithmetic. A real Obsidian run with multiple large files
  should confirm the exact muted/active visual balance and monotonic explorer timing.

## Next Steps

1. Exercise a folder containing at least two sequential large downloads and uploads in Obsidian.
2. Confirm collapsed-parent progress never moves backwards and queued colors stay legible in the
   user's active light/dark theme.

## Exit Criteria

- Two equal sequential downloads produce parent progress `0 -> 50 -> 100`, never two separate
  `0 -> 100` cycles.
- Different file sizes are aggregated by bytes.
- Visible queued file/folder indicators are visibly quieter than active transfers.
- Upload and download use the same activity semantics.
- Existing minimal-visible-parent roll-up, disconnect cancellation, persistence, and transfer
  safety behavior still pass automated checks.
