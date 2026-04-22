# Room Activity Feed

Status: CANDIDATE
Priority: Medium
Last reviewed: 2026-04-22

## Idea

Provide a feed of room activity, likely focused on who changed what.

## Why It Matters

- Could answer the user's repeated interest in seeing who wrote which changes.

## User Feedback

- The user sees potential value but is unsure about implementation.

## Risks / Constraints

- Needs a data model that stays affordable in memory and UX complexity.
- May require server support or durable local event history.

## Good Entry Points

- `docs/server-contract.md`
- presence / change logging systems
