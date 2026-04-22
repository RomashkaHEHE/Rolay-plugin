# Room Health Badge

Status: CANDIDATE
Priority: Medium
Last reviewed: 2026-04-22

## Idea

Expand the existing room status indicator near the room folder with richer states and a hover explanation.

## Why It Matters

- This builds directly on a UI pattern the user already understands.

## User Feedback

- User explicitly suggested expanding the current purple/gray indicator with more states and tooltip detail.

## Risks / Constraints

- New states must be legible and not overwhelming.

## Good Entry Points

- explorer room indicator logic in `src/main.ts`
- tooltip styling in `styles.css`
