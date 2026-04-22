# Automatic Stuck-Transfer Recovery

Status: CANDIDATE
Priority: Medium
Last reviewed: 2026-04-22

## Idea

Detect and recover transfers that appear stuck without always needing manual intervention.

## Why It Matters

- Fits the user's preference that the code should usually decide what to do on its own.

## User Feedback

- User sounded cautiously positive.

## Risks / Constraints

- Recovery must avoid duplicating work or corrupting state.
- Likely needs conservative heuristics plus good logging.

## Good Entry Points

- transfer state machine in `src/main.ts`
