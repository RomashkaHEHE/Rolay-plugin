# Safer Move Warnings

Status: CANDIDATE
Priority: Medium
Last reviewed: 2026-04-22

## Idea

Warn more clearly before risky moves in or out of rooms, especially when a file is not fully safe yet.

## Why It Matters

- Fits the project's data-safety priority.
- The user responded positively.

## User Feedback

- "Probably yes."

## Risks / Constraints

- Warnings should be specific and only appear when there is real risk.
- Avoid training users to ignore generic notices.

## Good Entry Points

- move/install safety logic in `src/main.ts`
- notices / explorer state surfaces
