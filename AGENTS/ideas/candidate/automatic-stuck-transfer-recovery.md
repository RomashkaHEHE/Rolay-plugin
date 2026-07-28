# Automatic Stuck-Transfer Recovery

Status: CANDIDATE
Priority: High
Last reviewed: 2026-07-28

## Idea

Detect and recover transfers that appear stuck without always needing manual intervention.

## Why It Matters

- Fits the user's preference that the code should usually decide what to do on its own.
- Reduces manual retry/refresh friction and avoids unnecessary notifications.

## User Feedback

- User sounded cautiously positive.
- User now explicitly wants routine internal work and recovery to happen without buttons or waiting
  on plugin UI.

## Risks / Constraints

- Recovery must avoid duplicating work or corrupting state.
- Likely needs conservative heuristics plus good logging.
- A timeout alone is not proof that work is stuck; use observed byte/event progress and transport
  lifecycle.
- Recovery must survive process suspension/restart and remain scoped to one room.
- Retry should be bounded and idempotent, with UI escalation only after automatic recovery is
  exhausted or data is at risk.

## Good Entry Points

- transfer state machine in `src/main.ts`
- resumable upload/download transports in `src/api/client.ts`
- persisted partial/pending state in `src/settings/data.ts`
