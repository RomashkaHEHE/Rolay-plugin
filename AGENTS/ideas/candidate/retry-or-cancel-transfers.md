# Retry Or Cancel Transfers

Status: CANDIDATE
Priority: Medium
Last reviewed: 2026-04-22

## Idea

Offer manual retry/cancel controls for problematic transfers.

## Why It Matters

- Could help unblock edge cases when automatic recovery is not enough.

## User Feedback

- The user prefers automatic behavior first, but is open to controls if the UI stays light.

## Risks / Constraints

- Must not become the normal path for healthy transfers.
- Needs careful UI placement to avoid clutter.

## Good Entry Points

- transfer lifecycle in `src/main.ts`
- secondary UI surfaces in `src/settings/tab.ts`
