# Unread Remote Changes

Status: CANDIDATE
Priority: High
Last reviewed: 2026-04-22

## Idea

Mark notes with a small unread indicator when remote changes landed but the local user has not meaningfully looked at them yet.

## Why It Matters

- Gives useful awareness without needing a heavy activity feed.
- Fits the academic workflow better than noisy "recent activity" UI.

## User Feedback

- This was one of the strongest positive reactions.
- The indicator should stay subtle because many notes may be unread at once.

## Risks / Constraints

- The unread model must not become noisy or confusing.
- Likely needs a clear "what counts as read?" rule.

## Good Entry Points

- `src/main.ts`
- explorer badge logic and note presence plumbing
