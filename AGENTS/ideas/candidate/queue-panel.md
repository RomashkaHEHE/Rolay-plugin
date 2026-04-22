# Queue Panel

Status: CANDIDATE
Priority: Medium
Last reviewed: 2026-04-22

## Idea

Show a lightweight panel for active transfers and pending sync work.

## Why It Matters

- Could help users understand stuck transfers.
- Also useful during debugging without opening raw logs.

## User Feedback

- User sees plausible value, especially for debug scenarios.

## Risks / Constraints

- Must not become mandatory for normal use.
- Better as an optional panel or secondary surface.

## Good Entry Points

- binary transfer state in `src/main.ts`
- settings/debug UI in `src/settings/tab.ts`
