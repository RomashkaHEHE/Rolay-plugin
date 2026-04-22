# Remote Edit Markers In Gutter

Status: CANDIDATE
Priority: Medium
Last reviewed: 2026-04-22

## Idea

Show lightweight markers in the editor gutter for incoming remote edits.

## Why It Matters

- Could add local awareness without requiring a full annotation system.

## User Feedback

- User is willing to try it.

## Risks / Constraints

- Must not become distracting during active lectures.
- Should cooperate with current cursor/presence UI instead of duplicating it.

## Good Entry Points

- CodeMirror integration in `src/realtime/shared-presence.ts`
