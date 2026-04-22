# Pinned Priority Downloads

Status: CANDIDATE
Priority: Medium
Last reviewed: 2026-04-22

## Idea

Let the user prioritize specific files for download when many transfers compete.

## Why It Matters

- Makes room installs feel smarter when one file matters right now.

## User Feedback

- User explicitly said this "would be nice."

## Risks / Constraints

- Needs clear rules so it does not fight automatic scheduling.
- Probably belongs on top of the existing transfer queue, not beside it.

## Good Entry Points

- preload/download scheduling in `src/main.ts`
