# Adaptive Preload

Status: CANDIDATE
Priority: High
Last reviewed: 2026-07-29

## Idea

Make preload smarter about what to fetch first instead of treating all content equally.

## Why It Matters

- Could improve room install feel without changing correctness rules.
- Directly supports faster startup and the goal that background completeness must not block useful
  work.

## User Feedback

- User is open to trying it but wants deeper thinking first.
- User now explicitly prioritizes startup speed, autonomy, and unobtrusive background loading.

## Runtime Evidence

- A real `1.2.21` binary create followed by two renames caused adjacent `local-op` and
  `event-stream` snapshots to run several full 113-document, roughly 230 KB Markdown bootstrap
  passes in about 25 seconds.
- No data mismatch occurred, but tree-only mutations should not repeatedly download unchanged
  Markdown state. Future design should coalesce the local operation with its SSE echo and skip
  Markdown bootstrap when the Markdown entry set/state metadata has not changed.

## Implemented Foundation

- Cursor-aware local-operation/SSE snapshot coalescing and safe binary-only Markdown-bootstrap
  skipping are implemented under
  [../../tasks/snapshot-refresh-coalescing.md](../../tasks/snapshot-refresh-coalescing.md).
- The broader idea remains a candidate: active-note-first ordering, adaptive batch/concurrency
  policy, and mobile-aware prioritization have not been implemented by this slice.

## Risks / Constraints

- Must not regress safety or correctness.
- Needs a clear scheduling policy, not ad hoc heuristics.
- The active/visible note should win, then nearby/user-requested work, then background room
  completeness.
- Concurrency and cache policy must be platform-aware; Android should not inherit desktop-sized
  assumptions blindly.
- Routine preload must stay silent unless it is degraded or blocks requested content.

## Good Entry Points

- preload/bootstrap scheduling in `src/main.ts`
- persisted CRDT/binary cache policy in `src/main.ts`
- platform defaults in `src/settings/data.ts`
