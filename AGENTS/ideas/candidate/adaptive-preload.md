# Adaptive Preload

Status: CANDIDATE
Priority: Medium
Last reviewed: 2026-04-22

## Idea

Make preload smarter about what to fetch first instead of treating all content equally.

## Why It Matters

- Could improve room install feel without changing correctness rules.

## User Feedback

- User is open to trying it but wants deeper thinking first.

## Risks / Constraints

- Must not regress safety or correctness.
- Needs a clear scheduling policy, not ad hoc heuristics.

## Good Entry Points

- preload/bootstrap scheduling in `src/main.ts`
