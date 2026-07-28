# Room Health Badge

Status: CANDIDATE
Priority: High
Last reviewed: 2026-07-28

## Idea

Expand the existing room status indicator near the room folder with richer states and a hover explanation.

## Why It Matters

- This builds directly on a UI pattern the user already understands.

## User Feedback

- User explicitly suggested expanding the current purple/gray indicator with more states and tooltip detail.
- In healthy solo use, this should become the main and almost only persistent Rolay indicator.

## Risks / Constraints

- New states must be legible and not overwhelming.
- Healthy state should be visually quiet and should not glow/pulse continuously.
- Recovering, degraded, disconnected-by-user, and action-required states must be distinguishable
  without relying only on color.
- Detail needs both hover and touch/focus access.

## Good Entry Points

- explorer room indicator logic in `src/main.ts`
- tooltip styling in `styles.css`
