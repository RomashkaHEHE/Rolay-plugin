# Adaptive Preload

Status: CANDIDATE
Priority: High
Last reviewed: 2026-07-28

## Idea

Make preload smarter about what to fetch first instead of treating all content equally.

## Why It Matters

- Could improve room install feel without changing correctness rules.
- Directly supports faster startup and the goal that background completeness must not block useful
  work.

## User Feedback

- User is open to trying it but wants deeper thinking first.
- User now explicitly prioritizes startup speed, autonomy, and unobtrusive background loading.

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
