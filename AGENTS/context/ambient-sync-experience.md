# Ambient Sync Experience

## Product Principle

Healthy sync is quiet. Detail appears only when context makes it useful or when the system needs
attention.

Rolay should feel like part of Obsidian rather than a second application that users must operate.
Opening a vault, editing a file, moving between notes, reconnecting after sleep, and receiving remote
changes should normally happen without a separate Rolay workflow.

## Attention Model

Use progressive disclosure instead of showing every available state all the time.

### Healthy Solo

This is the default visual baseline:

- the current local presence instance is the only authenticated viewer
- there are no anonymous public viewers
- no transfer or reconciliation needs attention
- the room is connected and caught up

In this state:

- retain only a subtle room connection/health mark
- self presence may remain in internal state but should not create prominent viewer chips or explorer
  badges by itself
- do not show routine success notices
- keep details reachable from the nearby room mark through hover, focus, or a compact contextual
  surface

### Active Collaboration

Reveal collaboration UI when another live presence instance or anonymous public viewer exists:

- note viewer chips
- explorer presence indicators using the minimal-visible-parent rule
- cursors and selections where applicable

Presence instances remain session/device based. Two live instances of the same account are still two
real participants and must not be deduplicated merely to make the UI quieter.

### Active Background Work

Show transfer progress only where it is relevant:

- on the visible file being transferred
- on the deepest visible collapsed parent when the file is hidden
- near the room root when room-wide installation state is the only useful summary

Progress is state, not an error. Avoid global notices for ordinary downloads, uploads, preload, retry,
or finalization.

Binary progress represents the whole known byte queue, not only the worker currently using the
network. Queued paths remain visible in a muted transfer color, active paths use the stronger color,
and completed siblings keep contributing to a collapsed parent's percentage until the cohort
finishes. This preserves information without making every queued file look equally urgent.

### Degraded But Recovering

Use the subtle room health mark as the first escalation point:

- change its state/color without adding a new permanent panel
- explain the current condition and automatic recovery on hover/focus
- keep bounded retry and recovery silent while data remains safe

Do not call a transient reconnect an error unless it persists or threatens continuity.

### Action Required Or Data Risk

Prominent UI and notifications are justified when:

- user action is required
- automatic recovery is exhausted
- local or remote work may be lost
- authentication or permissions block progress
- an update is mandatory for protocol safety

The message must say what happened, what Rolay already tried, and what action remains.

## Autonomy Rules

Normal operation should not depend on users pressing Refresh, Retry, Update, or Install repeatedly.

Prefer:

- deferred non-blocking startup
- local-first editing with durable pending work
- resumable transfers
- bounded retries with jitter/backoff
- idempotent reconciliation
- automatic stuck-work detection
- verified self-update and safe restart/reload behavior
- recovery after suspend, network change, and process termination

Manual controls can exist as escape hatches, but they are not the primary workflow.

## Performance Rules

- Do not block Obsidian's initial layout on room bootstrap or preload.
- Prioritize the active note and visible work before background room completeness.
- Bound concurrent network, hashing, disk, CRDT, and DOM work.
- Coalesce decoration updates without making direct user interactions feel delayed.
- Avoid full-tree or full-document work when an incremental update is sufficient.
- Preserve enough cached state for offline safety without assuming desktop-sized memory on mobile.

## Mobile Parity

Mobile support is a behavior requirement, not only `"isDesktopOnly": false`.

Every transport and lifecycle-sensitive feature must identify and verify:

- desktop Electron/Node path
- Android/mobile WebView path
- HTTPS/WSS and CORS requirements
- Obsidian `DataAdapter` compatibility
- app background/suspend and resume behavior
- network switching and temporary offline behavior
- memory and concurrency limits
- touch interaction and narrow viewport behavior
- updater replacement and reload/restart behavior

Do not silently fall back to a less safe protocol on mobile. If a platform cannot support a feature
yet, expose that as a tracked compatibility gap rather than claiming parity.

## Observability

Reducing interface noise must never erase operational evidence.

- Keep concise structured logs for transitions, retries, recovery, and terminal failures.
- Include platform and selected transport in relevant diagnostics.
- Keep detailed state available from the indicator closest to the affected room/file.
- Preserve the existing short retention and size limits so logs remain practical to share.

## Review Questions

Before shipping a sync/UX change, ask:

- What does a healthy solo user see?
- Does expected work complete without a button press?
- What happens after sleep, offline time, or process termination?
- Is the first visible escalation proportional to the problem?
- Can the same behavior run without Node/Electron?
- Can a later bug report still identify the first divergence?
