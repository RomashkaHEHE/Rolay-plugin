# Room Install Progress Panel

Status: CANDIDATE
Priority: High
Last reviewed: 2026-04-22

## Idea

Show room install progress more explicitly, both near the room folder and near the install action in settings.

## Why It Matters

- The user called this out directly.
- It complements the current per-file percentages with a room-level story.

## User Feedback

- The desired UX is explicit percent feedback beside the room folder and beside the install button.

## Risks / Constraints

- Needs a trustworthy progress model, not a fake guess.
- Should reuse byte-aware bootstrap/blob progress where possible.

## Good Entry Points

- room progress state in `src/main.ts`
- room settings UI in `src/settings/tab.ts`
