# Idea Index

Last updated: 2026-04-22

This file is the navigator for the future-work backlog.

See also:

- [parallel-workflow.md](parallel-workflow.md) for multi-branch idea development

## Current Guidance

When choosing the next substantial product feature, prefer this order unless the user says otherwise:

1. Strong UX wins with clear benefit and low ambiguity
2. File/sync features that improve safety or observability
3. Performance or diagnostics ideas that need more proof
4. Previously rejected ideas only if the workflow changes materially

## Near-Term Candidate Ideas

These are the most promising ideas from the current conversation.

1. [Unread remote changes](candidate/unread-remote-changes.md)
2. [Follow mode](candidate/follow-mode.md)
3. [Room install progress panel](candidate/room-install-progress-panel.md)
4. [Queue panel](candidate/queue-panel.md)
5. [Per-file status detail](candidate/per-file-status-detail.md)
6. [Safer move warnings](candidate/safer-move-warnings.md)
7. [Room health badge](candidate/room-health-badge.md)
8. [Notification polish](candidate/notification-polish.md)

## Recommended Parallel Branch Batch

If the team wants to develop several ideas in parallel, start with:

1. [Unread remote changes](candidate/unread-remote-changes.md)
2. [Follow mode](candidate/follow-mode.md)
3. [Room install progress panel](candidate/room-install-progress-panel.md)

## Candidate Ideas

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
- [Active-note-first scheduling](needs-discovery/active-note-first-scheduling.md)
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
