# Current State

Last updated: 2026-04-29

## Current Release Baseline

- Plugin version: `1.2.10`
- Latest notable commit in recent history before this AGENTS layer: `1a8c272` `Document presence and cursor sync behavior`

## Current Priorities

Priority order for most work unless the user explicitly overrides it:

1. Sync correctness and data safety
2. Collaboration UX correctness
3. Keep the AGENTS handoff layer current, especially backlog intent and product decisions
4. Performance/scaling improvements only after correctness

## Stable Product Invariants

These should be treated as high-confidence truths unless code/docs are intentionally changed:

- `workspace.id` is the only stable room identity.
- Tree sync is server-authoritative.
- Only `.md` files use CRDT/Yjs/Hocuspocus.
- Every non-`.md` file, including `.txt`, is binary/blob content.
- Default sync root is vault root (`/` in the settings UI).
- Note presence is room-level SSE plus per-document awareness; public-site anonymous viewers arrive as `anonymousViewerCount` and stay separate from authenticated `viewers[]`.
- Explorer presence badges use minimal-visible-parent aggregation: a note shows its own badge when visible, otherwise the badge rolls up only to the deepest visible collapsed parent inside the room root. Anonymous public viewers remain separate gray eye indicators and follow the same roll-up rule.
- Explorer folder expand/collapse interactions must refresh presence/transfer decorations immediately; do not rely only on the slower general decoration debounce for visible-parent recalculation.
- Red downloading/protected explorer paths and yellow uploading paths should always show a `0-100%` badge. Binary transfers use byte progress, remote placeholders start at `0%`, markdown locks use bootstrap metadata/cache state, and folders roll up child progress.
- Local delete operations keep a short pending-delete guard so stale snapshots cannot resurrect files while multi-file delete operations are still settling.
- Persistent `rolay-sync.log` is intentionally short-lived: entries older than 48 hours are removed, and noisy files are capped to a compact recent tail.
- Startup sync is deferred until after Obsidian workspace layout is ready; downloaded rooms then resume with a small stagger so auth/snapshot/preload work does not block the plugin loading screen.
- Room Disconnect is a hard per-room pause: it stops room SSE/presence, cancels scheduled snapshot/background markdown work, aborts active binary transfers for that workspace, invalidates in-flight upload tokens, and ignores late snapshot/bootstrap/download results without affecting other connected rooms.
- Remote markdown patches should preserve the local viewport.
- Remote cursor rendering has extra stabilization against stale backward awareness offsets.
- Room publication is private by default and public access is only through the separate server-root read-only site.

## Currently Active / Unfinished Work

### 1. Blob Transfer Trace Cleanup

Status: `TODO`, lower priority than sync correctness

Summary:

- Temporary blob transfer trace logging was added on both server and client to catch byte mismatches.
- It is useful right now, but should not remain noisy forever.
- Once binary/blob stability is considered good, trace should be downgraded, gated, or removed carefully.

Task file:

- [AGENTS/tasks/blob-transfer-trace-cleanup.md](tasks/blob-transfer-trace-cleanup.md)

### 2. Room Publication

Status: `IN_PROGRESS`

Summary:

- Server now supports room-level publication and a public read-only site.
- Plugin work includes payload model updates, publication endpoints, settings SSE support, and room-settings/admin UI.

Task file:

- [AGENTS/tasks/room-publication.md](tasks/room-publication.md)

## Idea Pipeline

Potential future work now lives in:

- [AGENTS/ideas/index.md](ideas/index.md)

Important current product decisions:

- Multi-pane note presence is intentionally deferred for now. The value looks low for the current academic-group workflow and the bug surface looks non-trivial.
- The next likely UX-facing work should come from the approved idea backlog rather than from broad new system rewrites.

## Recently Completed Work

These are important because future regressions will often land in these areas:

- Explorer binary transfer percent badges for upload/download
- Immediate `0%` red state for remote binary placeholders
- Minimal-visible-parent presence badges in explorer
- Viewer chips above notes
- Cursor hover/inline label styling and behavior
- Scroll-preserving remote markdown patches
- Remote cursor jitter reduction by mirroring CodeMirror remap and rejecting short-lived stale backward offsets
- BRAT-friendly release flow with plain semver tags like `1.2.8`
- Dedicated `AGENTS/ideas/*` backlog layer for candidate, discovery, and rejected ideas
- Room publication and public-site management in room settings
- Persistent log auto-retention for more practical bug reports
- Mandatory explorer progress badges for red/yellow sync states
- Pending-delete guard against stale snapshot resurrection during bulk local deletes
- Deferred/staggered startup sync so preload still runs without blocking Obsidian startup
- Hard per-room Disconnect semantics for active preload/blob work
- Immediate explorer decoration refresh after folder expand/collapse

## First Places To Look By Task Type

- Product/API truth:
  - [README.md](../README.md)
  - [docs/server-contract.md](../docs/server-contract.md)
- Repo navigation:
  - [docs/repo-map.md](../docs/repo-map.md)
- Bug triage:
  - [docs/debug-playbook.md](../docs/debug-playbook.md)
- Runtime truth from a user machine:
  - `.obsidian/plugins/rolay/data.json`
  - `.obsidian/plugins/rolay/rolay-sync.log`

## Handoff Expectations

If you change anything substantial, update at least one of:

- this file, if priorities/current state changed
- a file in `AGENTS/tasks/`, if a task moved forward or changed shape
- canonical docs in `README.md` / `docs/*`, if stable behavior changed
