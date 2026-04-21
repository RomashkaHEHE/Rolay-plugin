# Collaboration UX

## Main UX Goal

Users should understand collaboration state without opening developer tools or reading logs.

That is why the plugin deliberately exposes collaboration status in the interface:

- cursor colors
- cursor labels
- note presence chips
- explorer presence badges
- file loading/upload colors
- room connection indicators

## Viewer Presence Intent

Presence is not only about a text cursor.

People should count as present in a note when they are meaningfully viewing it, even if they are not currently moving the caret.

That is why note presence is split:

- room-level note presence stream for who is in a note
- per-document awareness for detailed cursor/selection rendering

## Explorer Badge Intent

Explorer decorations are not decorative fluff. They are operational UI:

- note/folder presence badges answer "who is here?"
- red loading state answers "is this fully here yet?"
- yellow upload state answers "is this still being sent?"
- room indicators answer "is this room connected?"

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

When changing collaboration UI, judge it by whether a non-technical user can answer these quickly:

- Who is in this note?
- Is this file still downloading?
- Is this file still uploading?
- Am I connected?
- Did the system just move me somewhere unexpectedly?
