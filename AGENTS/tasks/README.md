# Tasks

This directory contains active, queued, or recently completed implementation memory. Stable behavior
belongs in `README.md` and `docs/*`; product ideas that are not being implemented belong in
`AGENTS/ideas/*`.

## Active

- [Self update](self-update.md)
  Server-authoritative update discovery and verified force-update are implemented; deployment and a
  live two-version Obsidian test remain.
- [Mobile transport foundation](mobile-transport-foundation.md)
  Verify HTTPS/WSS, browser SSE/blob fallbacks, lifecycle recovery, and updater behavior on real
  Android/mobile before simplifying healthy-state UI.

## Queued

- [Blob transfer trace cleanup](blob-transfer-trace-cleanup.md)
  Decide when temporary client/server blob tracing can be gated or reduced without losing useful
  incident diagnostics.

Create new files from [../task-template.md](../task-template.md) and follow
[../task-protocol.md](../task-protocol.md).
