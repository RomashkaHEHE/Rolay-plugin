# Room Publication

Status: IN_PROGRESS
Priority: Medium
Last updated: 2026-04-27

## Goal

Update the Obsidian plugin for the new room publication feature so owners/admins can switch a room between private/public, members can see the status, and settings SSE keeps the UI fresh.

## Current Understanding

- Server now exposes room publication state in room payloads as `publication.enabled` and `publication.updatedAt`.
- Dedicated authenticated endpoints exist:
  - `GET /v1/rooms/{workspaceId}/publication`
  - `PATCH /v1/rooms/{workspaceId}/publication`
- Settings SSE now also emits `room.publication.updated`.
- Public site is server-root read-only and should only be linked to, not driven through private CRDT/blob flows.
- Old room payloads may omit `publication`; the plugin must treat that as private.

## Relevant Files

- [src/types/protocol.ts](../../src/types/protocol.ts)
- [src/api/client.ts](../../src/api/client.ts)
- [src/main.ts](../../src/main.ts)
- [src/settings/tab.ts](../../src/settings/tab.ts)
- [src/sync/settings-stream.ts](../../src/sync/settings-stream.ts)
- [README.md](../../README.md)
- [docs/server-contract.md](../../docs/server-contract.md)

## Progress Notes

- 2026-04-27: Task created. No implementation recorded here before this turn.
- 2026-04-27: Added protocol types, API client methods, room-cache normalization, settings SSE handling, and first-pass room/publication UI in both normal room detail and admin detail.
- 2026-04-27: `npm run check` and `npm run build` pass after the publication changes. Live manual verification is still the next important step.

## Open Questions / Risks

- Admin room detail and normal room detail should stay behaviorally aligned where sensible.
- The plugin should not accidentally promise room-specific public deep links, because the current public site only guarantees the root index.

## Next Steps

1. Manually verify owner/member/admin behavior against the live server.
2. Confirm `room.publication.updated` refreshes already-open settings views without reload.
3. Watch for any edge cases around admin inspect on rooms the admin does not personally belong to.

## Exit Criteria

- Owners/admins can toggle room publication from the plugin.
- Members can see public/private status but not mutate it.
- Settings SSE updates room publication state without reload.
- Public site link actions appear only when useful and are clearly read-only.
