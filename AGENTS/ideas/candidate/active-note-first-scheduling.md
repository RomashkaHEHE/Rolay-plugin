# Active-Note-First Scheduling

Status: CANDIDATE
Priority: High
Last reviewed: 2026-07-28

## Idea

Push the active note even harder to the front of scheduling decisions.

## Why It Matters

- Could improve perceived responsiveness in some workloads.
- Gives requested content priority while room-wide synchronization continues unobtrusively.

## User Feedback

- The user is not yet convinced there is enough extra value beyond the current behavior.
- The user now explicitly prioritizes startup speed, low friction, and autonomy, which makes this
  worth measuring and designing as part of adaptive preload.

## Required Discovery

- What does current scheduling already do?
- Define priorities across active note, visible explorer files, pinned/user-requested downloads, open
  CRDT sessions, and background room preload.
- Measure time to usable active note and impact on total room convergence.
- Define starvation prevention and platform-specific concurrency limits.

## Risks / Constraints

- Scheduling changes order, never correctness or authority.
- Background work must eventually complete.
- Opening/closing notes rapidly must not cause duplicate or abandoned transfers.

## Good Entry Points

- startup bootstrap and room resume scheduling in `src/main.ts`
- markdown preload queues in `src/main.ts`
- binary transfer scheduling in `src/main.ts`
