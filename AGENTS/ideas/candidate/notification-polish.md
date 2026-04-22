# Notification Polish

Status: CANDIDATE
Priority: Medium
Last reviewed: 2026-04-22

## Idea

Improve the plugin's notifications so it is clearer whether something is an error, warning, or info, possibly with copy affordances.

## Why It Matters

- The user explicitly said current notices do not clearly communicate intent.

## User Feedback

- Sounds/flash: no.
- Better structured notifications: yes.
- Emoji severity markers or a custom notice system are both acceptable directions.
- A copy button would be nice.

## Risks / Constraints

- Must not become flashy or childish.
- Severity semantics need to stay consistent.

## Good Entry Points

- notice creation sites in `src/main.ts`
- any shared notice helpers
