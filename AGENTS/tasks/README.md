# Tasks

This directory contains active, queued, or recently completed implementation memory. Stable behavior
belongs in `README.md` and `docs/*`; product ideas that are not being implemented belong in
`AGENTS/ideas/*`.

## Active

- [Mobile transport foundation](mobile-transport-foundation.md)
  Verify HTTPS/WSS, browser SSE/blob fallbacks, lifecycle recovery, and updater behavior on real
  Android/mobile before simplifying healthy-state UI.

## Watch

- [Binary transfer queue progress](binary-transfer-queue-progress.md)
  Full-queue byte aggregation, completed cohort retention, and muted queued states are implemented
  and automated; verify timing and visual balance with a real multi-file transfer.
- [Snapshot refresh coalescing](snapshot-refresh-coalescing.md)
  Cursor-aware local-op/SSE deduplication and safe binary-only Markdown-bootstrap skipping are
  implemented and automated; verify the traffic reduction in a real installed build.
- [Primary vault integrity audit](primary-vault-integrity-audit.md)
  Local/server content integrity and the real `1.2.21` single-commit binary path are verified;
  continue regression observation without treating it as unfinished implementation.

## Queued

- [Blob transfer trace cleanup](blob-transfer-trace-cleanup.md)
  Decide when temporary client/server blob tracing can be gated or reduced without losing useful
  incident diagnostics.

## Recently Completed

- [Client error reporting](client-error-reporting.md)
  Authenticated durable error delivery, strict redaction, request correlation, and structured
  server ingestion are implemented and verified; server support is deployed and plugin `1.2.24`
  is the release candidate.
- [Self update](self-update.md)
  Desktop `1.2.19 -> 1.2.20` automatic discovery, verification, installation, and soft reload are
  proven by the real vault `Main`.

Create new files from [../task-template.md](../task-template.md) and follow
[../task-protocol.md](../task-protocol.md).
