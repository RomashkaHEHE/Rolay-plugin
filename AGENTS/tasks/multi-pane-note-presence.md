# Multi-Pane Note Presence

Status: BLOCKED
Priority: Low
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
- 2026-04-22: Product direction changed. This is intentionally deferred because the current academic-group workflow rarely benefits from simultaneous multi-pane viewing, while the bug surface is fairly large.

## Open Questions / Risks

- Presence today is tied to the active markdown session; multi-pane support may require either multiple local viewer instances or a redesign of how the plugin tracks visible markdown leaves.
- Need to preserve the existing invariant that hidden tabs should not count as viewers.
- Need to ensure same-account multi-device and same-account multi-pane duplication keeps working intentionally.
- Right now the product value looks low relative to the risk, so this should not be resumed casually.

## Next Steps

1. Do not resume implementation unless the user explicitly reopens the idea.
2. If reopened, first revisit the product need in [AGENTS/ideas/rejected/multi-pane-note-presence.md](../ideas/rejected/multi-pane-note-presence.md).
3. Only then inspect how the plugin currently chooses the single active markdown session/viewer.

## Exit Criteria

- Two simultaneously visible panes for the same user can produce two viewer presences when appropriate.
- Hidden/inactive tabs do not count as viewers.
- Explorer badges and note chips remain consistent with the new behavior.
