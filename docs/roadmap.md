# Rolay Future Work Navigation

Stable runtime behavior belongs in `README.md` and the other files under `docs/`. Volatile product
priority, user feedback, and branch/task handoff state live under `AGENTS/` so this document does not
silently compete with the active backlog.

## Live Backlog

- [AGENTS idea index](../AGENTS/ideas/index.md)
  Prioritized candidate, needs-discovery, and rejected/deferred ideas.
- [Current state](../AGENTS/current-state.md)
  Active implementation tasks and recent regression-sensitive work.

The current product direction is general-purpose, low-friction synchronization:

- healthy solo sync should be almost invisible
- expected retries, preload, reconnects, and updates should be automatic
- collaboration and progress should appear contextually when useful
- Android/mobile parity must be verified explicitly

The rationale and implementation ordering live in:

- [Ambient sync experience](../AGENTS/context/ambient-sync-experience.md)
- [Cross-platform reliability](../AGENTS/ideas/candidate/cross-platform-reliability.md)
- [Ambient sync indicators](../AGENTS/ideas/candidate/ambient-sync-indicators.md)

Multi-pane note presence and Conflict Center remain intentionally deferred. They are not current
implementation priorities.

## Implemented Foundations

- Binary upload/download is byte-resumable across retries and restarts.
- Uploads continue from `upload-ticket.uploadedBytes`.
- Downloads continue from `.part` files plus ranged `GET /blob/content`.
- Final binary materialization happens only after complete size/hash verification.
- The working client uses HTTPS/WSS, has mobile-specific network limits, and restarts active live
  transports after Android resume/network recovery.
- The working server has a narrow Obsidian-origin CORS policy for browser SSE/blob fallbacks.

## Durable Technical Debt

These are known directions, not approved implementation tasks:

- session credentials still live in plugin data; secure storage needs platform and migration design
- HTTPS browser-fallback SSE/blob paths and lifecycle recovery still need a real Android device audit
- large-room scheduling needs more selective preload and active-work prioritization
- ordinary transfer/reconnect failures should gain conservative automatic stuck-work recovery
- temporary blob transfer tracing should eventually be gated or reduced once transport stability is
  established

Before implementing any item, check `AGENTS/ideas/*` and create/update an `AGENTS/tasks/*` handoff
file according to [the task protocol](../AGENTS/task-protocol.md).
