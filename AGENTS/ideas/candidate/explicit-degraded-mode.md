# Explicit Degraded Mode

Status: CANDIDATE
Priority: Medium
Last reviewed: 2026-04-22

## Idea

Expose a clearer "degraded mode" when sync is partially healthy but not fully normal.

## Why It Matters

- Could make existing room/sync indicators more informative without building whole new screens.

## User Feedback

- Extra indicators are welcome if they stay smart and unobtrusive.

## Risks / Constraints

- Must avoid panic-inducing false alarms.
- Probably best built on top of existing indicators, not as a separate dashboard.

## Good Entry Points

- room indicator states in `src/main.ts`
- tooltip copy and settings/debug UI
