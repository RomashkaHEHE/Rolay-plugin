# Multi-Pane Note Presence

Status: TODO
Priority: Medium
Last updated: 2026-04-22

## Goal

Make markdown note presence correctly represent multiple simultaneously visible panes inside one Obsidian window, without counting invisible tabs as viewers.

## Current Understanding

- Room-level note presence already exists and is driven by server SSE plus CRDT awareness.
- Current behavior is correct for one active visible note in a given client/window.
- Invisible tabs should not count as viewers.
- The known limitation is that two visible panes in one window do not yet publish two independent viewer presences.
- The current presence model is documented in:
  - [README.md](../../README.md)
  - [docs/roadmap.md](../../docs/roadmap.md)
  - [docs/repo-map.md](../../docs/repo-map.md)

## Relevant Files

- [src/realtime/crdt-session.ts](../../src/realtime/crdt-session.ts)
- [src/main.ts](../../src/main.ts)
- [src/sync/note-presence-stream.ts](../../src/sync/note-presence-stream.ts)
- [src/settings/tab.ts](../../src/settings/tab.ts)
- [docs/roadmap.md](../../docs/roadmap.md)

## Progress Notes

- 2026-04-22: Task documented in AGENTS layer. No implementation started here yet.

## Open Questions / Risks

- Presence today is tied to the active markdown session; multi-pane support may require either multiple local viewer instances or a redesign of how the plugin tracks visible markdown leaves.
- Need to preserve the existing invariant that hidden tabs should not count as viewers.
- Need to ensure same-account multi-device and same-account multi-pane duplication keeps working intentionally.

## Next Steps

1. Inspect how the plugin currently chooses the single active markdown session/viewer.
2. Decide whether to track presence per visible leaf or per visible editor view.
3. Implement without breaking current explorer badges and note chips.
4. Update canonical docs if the behavior changes materially.

## Exit Criteria

- Two simultaneously visible panes for the same user can produce two viewer presences when appropriate.
- Hidden/inactive tabs do not count as viewers.
- Explorer badges and note chips remain consistent with the new behavior.
