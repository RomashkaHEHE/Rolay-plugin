# Current State

Last updated: 2026-04-27

## Current Release Baseline

- Plugin version: `1.2.6`
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
- Explorer presence badges now exist both on markdown notes and on ancestor folders inside the room root, including separate gray eye indicators for anonymous public viewers.
- Binary transfers show progress in the explorer and placeholders should start at `0%`.
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
- Aggregated folder presence badges in explorer
- Viewer chips above notes
- Cursor hover/inline label styling and behavior
- Scroll-preserving remote markdown patches
- Remote cursor jitter reduction by mirroring CodeMirror remap and rejecting short-lived stale backward offsets
- BRAT-friendly release flow with plain semver tags like `1.2.6`
- Dedicated `AGENTS/ideas/*` backlog layer for candidate, discovery, and rejected ideas
- Room publication and public-site management in room settings

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
