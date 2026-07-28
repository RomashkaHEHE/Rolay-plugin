# Notification Polish

Status: CANDIDATE
Priority: High
Last reviewed: 2026-07-28

## Idea

Improve the plugin's notifications so it is clearer whether something is an error, warning, or info, possibly with copy affordances.

## Why It Matters

- The user explicitly said current notices do not clearly communicate intent.

## User Feedback

- Sounds/flash: no.
- Better structured notifications: yes.
- Emoji severity markers or a custom notice system are both acceptable directions.
- A copy button would be nice.
- The new direction is to reduce notification count through stability and automatic recovery, not by
  suppressing useful information.

## Risks / Constraints

- Must not become flashy or childish.
- Severity semantics need to stay consistent.
- Routine success, reconnect, preload, retry, and transfer progress should not create notices.
- Reserve notifications for user action, persistent failure, data risk, auth/permission blockers, or
  a meaningful requested completion.
- Copyable diagnostic detail should not force verbose technical text into the primary message.

## Good Entry Points

- notice creation sites in `src/main.ts`
- any shared notice helpers
