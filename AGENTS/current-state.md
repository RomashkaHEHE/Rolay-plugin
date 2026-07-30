# Current State

Last updated: 2026-07-30

## Current Release Baseline

- Plugin version: `1.2.23`
- Release baseline: `1.2.23` queue-aware byte-weighted binary transfer progress

## Current Priorities

Priority order for most work unless the user explicitly overrides it:

1. Sync correctness and data safety
2. Autonomous recovery and cross-platform reliability
3. Startup/resume speed and useful-work-first scheduling
4. Calm, contextual sync/collaboration UX
5. Keep the AGENTS handoff layer current, especially backlog intent and product decisions

Current product framing:

- Rolay is a general Obsidian synchronization tool with collaboration, not only a lecture-writing
  tool.
- Healthy solo sync should be almost invisible beyond a subtle room health mark.
- Detail should appear automatically when collaboration, active work, degradation, or required action
  makes it useful.
- Android/mobile behavior is a first-class requirement, not an incidental consequence of
  `"isDesktopOnly": false`.

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
- Binary folder progress is byte-weighted across the full known queue. Queued files use muted
  transfer colors, active workers use the stronger colors, and completed siblings remain in their
  cohort aggregate until all cohort work finishes so parent percentages cannot reset between
  sequential files.
- Room-wide markdown preload requires a large persistent CRDT cache. Do not lower `MAX_PERSISTED_CRDT_DOCS` back to tiny LRU values: downloaded notes will be pruned from `data.json`, then flicker red/normal and retrigger bootstrap loops even though the room was already downloaded.
- Local delete operations keep a short pending-delete guard so stale snapshots cannot resurrect files while multi-file delete operations are still settling.
- Bulk duplicate cleanup must stay possible even while markdown preload/locked-state is stale. Remote/suppressed delete echoes and already-pending deletes must be ignored before protected-markdown delete restoration, and safe `entryVersion=0` suffix-copy markdown duplicates may bypass the locked-delete restore so their `delete_entry` can reach the server.
- Authenticated REST/blob/SSE requests include `X-Rolay-Client: obsidian-plugin` and `X-Rolay-Client-Version`; keep this so the server can diagnose or reject stale clients if an old plugin build starts creating duplicate entries.
- Normal sync and public plugin update discovery use `https://rolay.ru`; update discovery remains a
  separate unauthenticated read-only surface.
- An HTTPS authority must not return insecure `ws:` CRDT or `http:` blob fallback targets; the client
  rejects them instead of downgrading.
- Self-update may replace only `main.js`, `manifest.json`, and `styles.css` after complete size/hash/manifest verification. It must preserve `data.json`, logs, caches, room bindings, and vault content.
- Self-update is autonomous: no update action is required. Discovery runs after startup, every
  15 minutes, and after network recovery; install waits for a safe sync/editor idle window and
  temporary failures retry with backoff. `General -> Plugin Version` may expose an optional
  check-now diagnostic for release testing, but it must use the same verified pipeline and never
  become a force-install bypass. Only restart-required or persistent retry failure is shown.
- Persistent `rolay-sync.log` is intentionally short-lived: entries older than 48 hours are removed, and noisy files are capped to a compact recent tail.
- Startup sync is deferred until after Obsidian workspace layout is ready; downloaded rooms then resume with a small stagger so auth/snapshot/preload work does not block the plugin loading screen.
- Room Disconnect is a hard per-room pause: it stops room SSE/presence, cancels scheduled snapshot/background markdown work, aborts active binary transfers for that workspace, invalidates in-flight upload tokens, and ignores late snapshot/bootstrap/download results without affecting other connected rooms.
- Disconnected/stopped rooms must not persist new markdown/binary create replay records from Obsidian vault `create` events. Existing remote files can otherwise be misclassified as local creates on startup/reconnect, causing runaway `(1)`, `(2)`, ... duplicates.
- Binary pending-write reconciliation must not request a rerun for an upload worker that is already
  active. Publishing the same committed hash, size, and MIME type is a client no-op, and the server
  must also treat an identical revision as idempotent after validating preconditions.
- A local binary write supersedes an older same-path download. The download is canceled first, and
  every late ticket/chunk/progress/finalize callback is gated by its persisted transfer `cohortId`
  so it cannot replace the queued upload state or write stale bytes into the vault.
- Remote markdown patches should preserve the local viewport.
- Remote cursor rendering has extra stabilization against stale backward awareness offsets.
- Full-room closed-Markdown reconciliation is a safety fallback, not a hot poll. Snapshots hydrate
  immediately, open notes use realtime WSS, snapshot bursts coalesce for 15 seconds, and the quiet
  fallback runs once per minute.
- Local tree operations and their SSE echoes carry the server cursor into snapshot scheduling.
  Covered cursors are discarded, and cursor-backed event/successful-local-op snapshots skip
  room-wide Markdown bootstrap only when the active Markdown `entryId -> path` set and hydrated
  cache are healthy. Failed operations and forced startup/lifecycle/recovery paths remain
  unconditional.
- Room publication is private by default and public access is only through the separate server-root read-only site.
- Quiet healthy-state presentation must not remove underlying presence, transfer state, or durable
  diagnostics. It is a rendering/attention policy, not a protocol simplification.

## Current Reliability And Experience Initiative

Status: `DEVICE VERIFICATION`

Product intent:

- make healthy synchronization ambient and low-noise
- recover from routine failures without manual buttons
- reduce startup and requested-content latency
- preserve clear contextual state when collaboration or real problems exist
- establish verified Android/mobile parity

Implemented in the current worktrees:

- main plugin sync authority migrated to `https://rolay.ru`
- strict server CORS allowlist for Obsidian app origins and sync/transfer headers
- actual platform/SSE/blob transport diagnostics
- immediate generation-safe SSE reconnect after online/mobile resume
- mobile background CRDT presence cleanup and active-note rebind
- lower mobile batch/chunk/download concurrency
- updated WebSocket dependencies with zero remaining plugin `npm audit` findings
- explicit `{}` JSON bodies for bodyless API mutations so Android `requestUrl` cannot turn CRDT
  token and blob download-ticket requests into unsupported plain-text requests

Remaining risks before claiming mobile parity:

- mobile lacks the preferred Electron/Node SSE and blob transports
- SSE therefore uses browser streaming fetch, and blob transfer uses XHR/fetch fallbacks
- actual Android origin, browser streaming behavior, CRDT WSS, app suspend/resume, network switching,
  interrupted transfers, and updater reload still need complete real-device verification

Production rollout `978f311` on 2026-07-28 confirmed that `https://rolay.ru/v1/auth/me` reaches the
authenticated API (`401` without credentials), `app://obsidian.md` receives the required CORS and
preflight headers, unknown origins receive no CORS permission, and
`https://rolay.ru/v1/plugin-updates/latest` serves the verified current release. SSE/blob/WSS
behavior on a real mobile client remains partially verified. The first Android install of room
`main` reached tree/SSE/bootstrap successfully, but exposed bodyless request failures before CRDT
WSS and blob byte download could start. Server compatibility commit `4fe1f0b` is deployed, plugin
release `1.2.20` is published from commit `48418f7`, and authenticated production probes now return
valid CRDT and blob download tickets. A repeat Android install is still required to verify the
device-side WSS and byte-transfer paths end to end.

This is captured in:

- [Ambient sync experience](context/ambient-sync-experience.md)
- [Cross-platform reliability](ideas/candidate/cross-platform-reliability.md)
- [Ambient sync indicators](ideas/candidate/ambient-sync-indicators.md)
- [Mobile transport foundation task](tasks/mobile-transport-foundation.md)

## Currently Active / Unfinished Work

### 1. Mobile Transport Foundation

Status: `IN_PROGRESS`

Summary:

- The first reliability/experience slice is a verified HTTPS/WSS and mobile lifecycle foundation.
- HTTPS authority migration, server CORS, reconnect lifecycle, and diagnostics are implemented and
  pass automated checks.
- Server mobile request compatibility is deployed in commit `4fe1f0b`; plugin `1.2.20` carries the
  matching explicit-JSON client fix. Android SSE/blob/CRDT/updater verification remains incomplete
  until the release is exercised on the phone.
- Do not make the healthy-state UI quieter until its underlying mobile health signals are trustworthy.

Task file:

- [AGENTS/tasks/mobile-transport-foundation.md](tasks/mobile-transport-foundation.md)

### 2. Primary Vault Integrity And Binary Idempotency

Status: `WATCH`

Summary:

- The real room `main` is content-clean: 179 server/local paths, 113 Markdown Yjs texts, and 34
  binary SHA-256 values match exactly, with no pending operation or transfer state.
- Its original import nevertheless committed every binary revision twice because snapshot replay
  marked active uploads for rerun.
- Server identical-revision protection is deployed in commit `c70836b` through successful workflow
  run `30386327315`. Matching client active-worker suppression, committed-revision no-op, and
  failed-token cleanup are released in plugin `1.2.21`.
- A real `1.2.21` PNG upload produced one placeholder event (`248`), one blob commit (`249`), and
  only the two intentional rename events (`250-251`). Active-upload pending reconciliation did not
  start a second transfer; all durable queues converged to zero.

Task file:

- [AGENTS/tasks/primary-vault-integrity-audit.md](tasks/primary-vault-integrity-audit.md)

### 3. Snapshot Refresh Coalescing

Status: `WATCH`

Summary:

- A real PNG create plus two renames exposed nine complete 113-document bootstrap passes in roughly
  25 seconds.
- Cursor-aware scheduled/in-flight request merging now removes local-op/SSE duplicate snapshots.
- Binary-only snapshots preserve tree/blob reconciliation but skip unchanged healthy Markdown
  bootstrap.
- Exact active-bootstrap target tracking keeps optimistic Markdown create/delete/rename races safe.
- Eight focused tests pass; real installed-vault timing and convergence still need verification.

Task file:

- [AGENTS/tasks/snapshot-refresh-coalescing.md](tasks/snapshot-refresh-coalescing.md)

### 4. Blob Transfer Trace Cleanup

Status: `TODO`, lower priority than sync correctness

Summary:

- Temporary blob transfer trace logging was added on both server and client to catch byte mismatches.
- It is useful right now, but should not remain noisy forever.
- Once binary/blob stability is considered good, trace should be downgraded, gated, or removed carefully.

Task file:

- [AGENTS/tasks/blob-transfer-trace-cleanup.md](tasks/blob-transfer-trace-cleanup.md)

## Idea Pipeline

Potential future work now lives in:

- [AGENTS/ideas/index.md](ideas/index.md)

Important current product decisions:

- Multi-pane note presence is intentionally deferred for now. The value looks low for the current academic-group workflow and the bug surface looks non-trivial.
- The reliability/experience initiative now comes before unrelated collaboration features.
- The first runtime slice should verify the HTTPS/WSS mobile transport foundation before visual
  simplification makes health state quieter.

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
- Verified a primary-vault import path-by-path and byte-by-byte against production, then reduced
  no-op full-room Markdown polling from a tight five-second loop to a burst-coalesced one-minute
  fallback
- Replaced manual self-update controls with silent automatic discovery, verified safe-idle install,
  connectivity-aware retry/backoff, and exception-only restart/error UI
- Released `1.2.20` with Android bodyless-request compatibility and the optional same-pipeline
  check-now diagnostic; GitHub release assets and production update-proxy bytes were verified
- Verified the complete automatic desktop `1.2.19 -> 1.2.20` installation and soft reload in the
  real vault `Main`, with room bindings, caches, and sync resume preserved
- Released `1.2.21` with binary upload replay suppression; GitHub workflow `30386634559`, all five
  assets, archive contents, and production updater bytes were verified
- Verified a real post-release binary upload creates exactly one blob revision even when an
  event-stream snapshot observes its active pending write
- Released `1.2.22` with cursor-aware snapshot coalescing and conditional Markdown preload; GitHub
  workflow `30453648991`, all five assets, archive contents, and production updater bytes were
  verified
- Prepared `1.2.23` with queue-aware binary progress: full known byte totals, monotonic
  completed-cohort contribution, muted queued download/upload styling, stale-worker guards, and a
  local-size guard for persisted cache hits

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
