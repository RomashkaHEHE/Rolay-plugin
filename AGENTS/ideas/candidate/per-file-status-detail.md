# Per-File Status Detail

Status: CANDIDATE
Priority: Medium
Last reviewed: 2026-04-22

## Idea

Expose more detail for a file's sync state, likely on hover rather than on click.

## Why It Matters

- Builds on the current progress/status badges without cluttering the explorer.
- Could reduce the need to inspect logs for everyday issues.

## User Feedback

- The user liked the idea more as a hover surface than as a click-driven panel.

## Risks / Constraints

- Must remain lightweight in large room trees.
- Should reuse existing status sources instead of inventing new state.

## Good Entry Points

- explorer decoration logic in `src/main.ts`
- tooltip styling in `styles.css`
