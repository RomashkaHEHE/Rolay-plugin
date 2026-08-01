# Ambient Sync Indicators

Status: PARTIALLY IMPLEMENTED
Priority: High
Last reviewed: 2026-08-02

## Idea

Replace the current always-visible collection of sync/presence decorations with one coherent
progressive-disclosure model.

Healthy solo synchronization should be represented only by a subtle room health mark. Presence,
progress, and warning detail should appear automatically when another participant exists, work is
active, or health degrades.

## Why It Matters

- Rolay is becoming a general synchronization tool, not only a live lecture workspace.
- Self-only viewer chips and badges repeat information the user already knows.
- The current indicators are individually useful but can collectively take too much visual attention.
- Contextual detail can preserve observability without making the file explorer look permanently busy.

## User Feedback

- In a healthy solo session, the user wants almost no Rolay indicators.
- A small circle or similarly subtle shape showing that synchronization is online is acceptable.
- Indicators must stay just as informative when information is actually useful.
- Users should not need to open a separate page to understand current state.
- Explorer feedback on 2026-08-02 showed that the colored room square and viewer circles still
  pulled attention away from filenames. The requested direction is smaller, more separated,
  lower-contrast resting marks that remain easy to find intentionally.

## Implemented Slice

- Version `1.2.26` replaces the bright room pseudo-square with a small trailing status
  dot and reduces the resting size, saturation, and weight of presence, anonymous-viewer, and
  transfer badges.
- Hovering a file/folder row restores indicator opacity; every compact mark has an informative
  Obsidian tooltip with a `140 ms` delay so quiet presentation does not remove meaning.
- Transfer aggregation, mandatory percentages, minimal-visible-parent placement, and presence state
  are unchanged. See [explorer-indicator-quieting.md](../../tasks/explorer-indicator-quieting.md).

## Proposed State Ladder

1. Healthy solo: subtle room health mark only.
2. Collaboration: reveal remote/session presence and anonymous viewer UI near affected notes.
3. Active work: reveal contextual transfer/install progress using minimal-visible-parent aggregation.
4. Recovering/degraded: change the room mark and provide nearby hover/focus detail.
5. Action required/data risk: persistent message with a concrete action.

## Important Semantics

- Keep publishing and storing the local self-viewer; suppress only redundant rendering.
- A second live `presenceId`, including the same `userId` on another device/window, is real
  collaboration and must remain visible.
- Any anonymous viewer count is meaningful and keeps the gray eye indicator visible.
- Do not hide active `100%` finalization merely to make the UI quieter.
- Do not encode health only by color; tooltip/focus text and shape/icon state must remain accessible.

## Risks / Constraints

- Quiet UI must not conceal a stuck transfer, stale room, or data-risk state.
- Explorer updates must remain immediate after tree expand/collapse.
- Presence rendering must not alter server awareness semantics.
- Avoid adding a separate dashboard as the only way to inspect state.
- Mobile hover does not exist; contextual detail needs a touch/focus path.

## Good Entry Points

- presence and transfer decoration calculation in `src/main.ts`
- room folder status classes in `src/main.ts`
- indicator styling in `styles.css`
- note presence bar rendering in `src/main.ts`
- room health/settings summaries in `src/settings/tab.ts`

## First Safe Slice

Hide self-only authenticated note chips/explorer presence badges when all of these are true:

- there is exactly one live authenticated presence instance and it is the current local instance
- `anonymousViewerCount` is `0`
- no other collaboration state needs display

Keep the optimistic self-viewer in state, retain the room health mark, and add focused tests for
same-account multi-device presence and anonymous viewers before broad visual restyling.
