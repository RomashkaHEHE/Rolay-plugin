# Idea Index

Last updated: 2026-07-28

This file is the navigator for the future-work backlog.

See also:

- [parallel-workflow.md](parallel-workflow.md) for multi-branch idea development

## Current Guidance

The current direction is general-purpose, low-friction synchronization. Prefer this order unless the
user says otherwise:

1. Cross-platform correctness, safety, and automatic recovery
2. Startup/resume speed and useful-work-first scheduling
3. Quiet contextual sync/collaboration indicators
4. Additional collaboration features
5. Diagnostics or rejected ideas only when evidence/workflow changes justify them

## Near-Term Candidate Ideas

These form the current reliability and experience initiative.

1. [Cross-platform reliability](candidate/cross-platform-reliability.md)
2. [Ambient sync indicators](candidate/ambient-sync-indicators.md)
3. [Automatic stuck-transfer recovery](candidate/automatic-stuck-transfer-recovery.md)
4. [Adaptive preload](candidate/adaptive-preload.md)
5. [Active-note-first scheduling](candidate/active-note-first-scheduling.md)
6. [Room health badge](candidate/room-health-badge.md)
7. [Explicit degraded mode](candidate/explicit-degraded-mode.md)
8. [Notification polish](candidate/notification-polish.md)

## Recommended Implementation Order

Treat these as one initiative with explicit boundaries:

1. Verify the mobile-safe HTTPS/WSS transport foundation.
2. Establish automatic recovery and useful-work-first scheduling.
3. Simplify healthy-state indicators once their underlying health signals are trustworthy.

Discovery and measurements can run on parallel branches, but coordinate implementation touching
`src/main.ts`, `src/api/client.ts`, and `styles.css` according to
[parallel-workflow.md](parallel-workflow.md).

## Candidate Ideas

- [Cross-platform reliability](candidate/cross-platform-reliability.md)
- [Ambient sync indicators](candidate/ambient-sync-indicators.md)
- [Active-note-first scheduling](candidate/active-note-first-scheduling.md)
- [Unread remote changes](candidate/unread-remote-changes.md)
- [Follow mode](candidate/follow-mode.md)
- [Queue panel](candidate/queue-panel.md)
- [Per-file status detail](candidate/per-file-status-detail.md)
- [Retry or cancel transfers](candidate/retry-or-cancel-transfers.md)
- [Pinned priority downloads](candidate/pinned-priority-downloads.md)
- [Room install progress panel](candidate/room-install-progress-panel.md)
- [Safer move warnings](candidate/safer-move-warnings.md)
- [Remote edit markers in gutter](candidate/remote-edit-markers-in-gutter.md)
- [Room dashboard](candidate/room-dashboard.md)
- [Room activity feed](candidate/room-activity-feed.md)
- [Room health badge](candidate/room-health-badge.md)
- [Automatic stuck-transfer recovery](candidate/automatic-stuck-transfer-recovery.md)
- [Explicit degraded mode](candidate/explicit-degraded-mode.md)
- [Adaptive preload](candidate/adaptive-preload.md)
- [Transfer debug drawer](candidate/transfer-debug-drawer.md)
- [Searchable room activity/errors](candidate/searchable-room-activity-errors.md)
- [Copy room diagnostics](candidate/copy-room-diagnostics.md)
- [Notification polish](candidate/notification-polish.md)
- [Mini onboarding inside plugin](candidate/mini-onboarding.md)

## Needs Discovery

- [Last editor lineage](needs-discovery/last-editor-lineage.md)
- [Comment or annotation layer](needs-discovery/comment-annotation-layer.md)
- [Draft mode for offline edits](needs-discovery/draft-mode-for-offline-edits.md)
- [Version checkpoints](needs-discovery/version-checkpoints.md)
- [Per-room preferences](needs-discovery/per-room-preferences.md)
- [Secure session storage](needs-discovery/secure-session-storage.md)
- [Structured diagnostics export](needs-discovery/structured-diagnostics-export.md)
- [Feature flags for risky systems](needs-discovery/feature-flags-for-risky-systems.md)
- [Presence throttling](needs-discovery/presence-throttling.md)
- [Large-room virtualized diagnostics](needs-discovery/large-room-virtualized-diagnostics.md)
- [Avatar initials](needs-discovery/avatar-initials.md)
- [Hover card on viewer chip](needs-discovery/hover-card-on-viewer-chip.md)

## Rejected / Deferred For Now

- [Multi-pane note presence](rejected/multi-pane-note-presence.md)
- [Recent activity badge](rejected/recent-activity-badge.md)
- [Jump to collaborator](rejected/jump-to-collaborator.md)
- [Conflict center](rejected/conflict-center.md)
- [Presence heat](rejected/presence-heat.md)
- [Typing indicator](rejected/typing-indicator.md)
- [Session chips](rejected/session-chips.md)
- [Temporary highlight of incoming edits](rejected/temporary-highlight-of-incoming-edits.md)
- [Selection ownership](rejected/selection-ownership.md)
- [Membership diff view](rejected/membership-diff-view.md)
- [Bulk admin actions](rejected/bulk-admin-actions.md)

## Promotion Rules

Promote an idea from `ideas/` to `tasks/` when all of these are true:

- the user still wants it
- the problem statement is concrete enough to implement
- there is a plausible file-entry-point plan
- the work is more than a tiny one-shot change

When that happens:

1. Keep the idea file as the product-history record
2. Create or update a task file in `AGENTS/tasks/`
3. Link the task in the idea file if helpful
