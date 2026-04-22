# Follow Mode

Status: CANDIDATE
Priority: High
Last reviewed: 2026-04-22

## Idea

Let one user follow another collaborator's viewport/cursor in a note, useful when one person is driving a shared lecture note and others mostly watch.

## Why It Matters

- Matches a real classroom workflow the user explicitly described.
- Has immediate collaboration value, unlike more speculative presence ideas.

## User Feedback

- Strong positive reaction.
- The user explicitly connected it to "one person writes the notes, others watch."

## Risks / Constraints

- Must stay opt-in.
- Should not fight local scrolling or make the interface feel trapped.

## Good Entry Points

- `src/realtime/shared-presence.ts`
- `src/realtime/crdt-session.ts`
