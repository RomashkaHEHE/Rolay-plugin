# Explicit Degraded Mode

Status: CANDIDATE
Priority: High
Last reviewed: 2026-07-28

## Idea

Expose a clearer "degraded mode" when sync is partially healthy but not fully normal.

## Why It Matters

- Could make existing room/sync indicators more informative without building whole new screens.

## User Feedback

- Extra indicators are welcome if they stay smart and unobtrusive.
- Healthy operation should be almost invisible; degraded state should reuse the nearest existing
  indicator and reveal detail contextually.

## Risks / Constraints

- Must avoid panic-inducing false alarms.
- Probably best built on top of existing indicators, not as a separate dashboard.
- Distinguish transient automatic recovery from persistent degradation and action-required state.
- Mobile needs tap/focus disclosure because hover-only detail is insufficient.

## Good Entry Points

- room indicator states in `src/main.ts`
- tooltip copy and settings/debug UI
