# Tasks

This directory contains active, queued, or recently completed implementation memory. Stable behavior
belongs in `README.md` and `docs/*`; product ideas that are not being implemented belong in
`AGENTS/ideas/*`.

## Active

- [Mobile transport foundation](mobile-transport-foundation.md)
  Verify HTTPS/WSS, browser SSE/blob fallbacks, lifecycle recovery, and updater behavior on real
  Android/mobile before simplifying healthy-state UI.
- [Primary vault integrity audit](primary-vault-integrity-audit.md)
  Local/server content integrity is proven; the server duplicate-commit guard is deployed and the
  matching plugin `1.2.21` guard awaits release/runtime verification.

## Queued

- [Blob transfer trace cleanup](blob-transfer-trace-cleanup.md)
  Decide when temporary client/server blob tracing can be gated or reduced without losing useful
  incident diagnostics.

## Recently Completed

- [Self update](self-update.md)
  Desktop `1.2.19 -> 1.2.20` automatic discovery, verification, installation, and soft reload are
  proven by the real vault `Main`.

Create new files from [../task-template.md](../task-template.md) and follow
[../task-protocol.md](../task-protocol.md).
