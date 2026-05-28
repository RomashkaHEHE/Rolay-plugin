# Current State

Last updated: 2026-05-29

## Current Release Baseline

- Plugin version: `1.2.16`
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
- The active local markdown note also gets an optimistic self-viewer overlay. Viewer chips/explorer badges must not wait for the server SSE echo to show the current user, especially when only anonymous public viewers are present.
- Explorer presence badges use minimal-visible-parent aggregation: a note shows its own badge when visible, otherwise the badge rolls up only to the deepest visible collapsed parent inside the room root. Anonymous public viewers remain separate gray eye indicators and follow the same roll-up rule.
- Explorer folder expand/collapse interactions must refresh presence/transfer decorations immediately. Use both interaction hooks and the file-explorer DOM mutation observer; do not rely only on the slower general decoration debounce for visible-parent recalculation.
- Red downloading/protected explorer paths and yellow uploading paths should always show a `0-100%` badge. Binary transfers use byte progress, remote placeholders start at `0%`, and markdown locks use bootstrap metadata/cache state. Explorer transfer badges use the same minimal-visible-parent roll-up model as note presence: visible files show their own progress, collapsed parents aggregate hidden children, and expanded ancestors should not stay red/yellow just because a descendant is active. Do not hide badges merely because progress is `100%`; visibility should be driven by whether there is still an active transfer/protection/install phase.
- Room-wide markdown preload requires a large persistent CRDT cache. Do not lower `MAX_PERSISTED_CRDT_DOCS` back to tiny LRU values: downloaded notes will be pruned from `data.json`, then flicker red/normal and retrigger bootstrap loops even though the room was already downloaded.
- Local delete operations keep a short pending-delete guard so stale snapshots cannot resurrect files while multi-file delete operations are still settling.
- Bulk duplicate cleanup must stay possible even while markdown preload/locked-state is stale. Remote/suppressed delete echoes and already-pending deletes must be ignored before protected-markdown delete restoration, and safe `entryVersion=0` suffix-copy markdown duplicates may bypass the locked-delete restore so their `delete_entry` can reach the server.
- Authenticated REST/blob/SSE requests include `X-Rolay-Client: obsidian-plugin` and `X-Rolay-Client-Version`; keep this so the server can diagnose or reject stale clients if an old plugin build starts creating duplicate entries.
- Persistent `rolay-sync.log` is intentionally short-lived: entries older than 48 hours are removed, and noisy files are capped to a compact recent tail.
- Startup sync is deferred until after Obsidian workspace layout is ready; downloaded rooms then resume with a small stagger so auth/snapshot/preload work does not block the plugin loading screen.
- Room Disconnect is a hard per-room pause: it stops room SSE/presence, cancels scheduled snapshot/background markdown work, aborts active binary transfers for that workspace, invalidates in-flight upload tokens, and ignores late snapshot/bootstrap/download results without affecting other connected rooms.
- Disconnected/stopped rooms must not persist new markdown/binary create replay records from Obsidian vault `create` events. Existing remote files can otherwise be misclassified as local creates on startup/reconnect, causing runaway `(1)`, `(2)`, ... duplicates.
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
- Optimistic local self-viewer overlay for active note presence
- Guard against disconnected-room stale create replays generating duplicate markdown/binary entries
- Increased persistent markdown/binary cache caps so room preload can keep downloaded state for large rooms without red/normal flicker
- Fixed markdown explorer folder percentages so completed bootstrap documents keep contributing to parent progress until the active preload finishes
- Hardened bulk duplicate deletion against protected-markdown restore races and longer stale-snapshot windows
- Added client/version headers on authenticated API, blob, and SSE traffic for stale-client diagnostics/enforcement
- Switched explorer transfer progress to minimal-visible-parent roll-up so expanded folders do not keep noisy/stale red percentage badges when their visible children are already normal; completed markdown siblings contribute to a collapsed folder percentage only when the same folder still contains active incomplete work

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
