# Collaboration UX

## Main UX Goal

Collaboration state should become obvious when collaboration is happening, but it should not dominate
ordinary solo synchronization.

The presentation target is:

- healthy solo use: only a subtle room health mark
- another authenticated presence instance: relevant viewer chips, explorer badges, and cursors
- anonymous public viewers: separate gray eye indicators
- active transfer: contextual progress on the file or deepest visible collapsed parent
- degraded/action-required state: progressively stronger room/file UI and, only when justified, a
  notification

The underlying presence and transfer models remain complete even when a quiet state is visually
suppressed.

## Viewer Presence Intent

Presence is not only about a text cursor.

People should count as present in a note when they are meaningfully viewing it, even if they are not currently moving the caret.

That is why note presence is split:

- room-level note presence stream for who is in a note
- per-document awareness for detailed cursor/selection rendering

The current local presence instance should still be published immediately and optimistically. Quiet
solo presentation is a rendering decision, not permission to omit or delay awareness.

## Explorer Badge Intent

Explorer decorations are not decorative fluff. They are operational UI:

- note/folder presence badges answer "who is here?"
- red loading state answers "is this fully here yet?"
- yellow upload state answers "is this still being sent?"
- room indicators answer "is this room connected?"

Operational does not mean permanently prominent. A self-only authenticated presence badge can be
suppressed in healthy solo mode because it adds no new information; remote sessions, duplicate live
instances from another device/window, and anonymous viewers remain meaningful and should reveal the
relevant UI.

Presence and transfer progress should avoid noisy ancestor spam. Use the minimal visible parent rule:

- if the file is visible, show the badge on the file
- if the file is hidden inside a collapsed folder, roll the badge up to the deepest visible collapsed parent
- if a folder is expanded, do not keep showing the same child state on that expanded ancestor
- do not suppress a `100%` badge just because it is `100%`; if work is still active, `100%` can honestly mean "downloaded, now finalizing/applying"

## Cursor Behavior Intent

Cursor rendering has several goals at once:

- be easy to visually track
- avoid covering text unnecessarily
- reveal the name when needed
- not jitter when local text shifts offsets before remote awareness catches up

This is why there are special behaviors like:

- easier hover hitbox
- end-of-line inline label
- stabilization against stale backward awareness offsets

## Viewport Preservation Intent

When someone else edits, the local user's reading position should remain stable.

A live collaboration plugin that constantly yanks the viewport is functionally correct but operationally bad.

So remote text apply must preserve the local viewport unless there is an intentional reason to reveal something.

## Implication For Future Agents

When changing collaboration UI, judge it by both calmness and discoverability:

- Does a healthy solo vault still look and feel like ordinary Obsidian?
- When someone else arrives, is that visible at the relevant note?
- While work is active, can the user tell what is happening without opening settings?
- When something is degraded, is detail available from the nearest indicator?
- Did the system move the viewport or demand an avoidable manual action?

See [ambient-sync-experience.md](ambient-sync-experience.md) for the full attention hierarchy.
