# Client Error Reporting

Status: DONE
Priority: High
Last updated: 2026-07-30

## Goal

Deliver actionable plugin errors to the Rolay server automatically without blocking sync, leaking
credentials/note content, or creating an error-reporting feedback loop.

## Current Understanding

- The plugin already centralizes persisted logs through `recordLog`; all `error` entries can feed
  one reporting pipeline.
- Reports must survive offline periods and plugin restarts, so a small bounded pending queue belongs
  in `data.json`.
- Repeated transport/reconnect failures should be aggregated client-side instead of producing one
  request and server log line per occurrence.
- The server endpoint is authenticated. Errors captured before login remain queued and send after a
  valid session is available.
- Useful context includes plugin/Obsidian versions, platform/runtime/network state, persistent
  installation ID, active path, room connection IDs, pending-work counts, stack/HTTP metadata, and
  a short recent-log breadcrumb tail.
- Tokens, passwords, note contents, and unrestricted objects must never enter the report payload.
- Delivery failure must stay local, retry with backoff, and never be captured as another report.

## Contract

- `POST /v1/client-errors`
- Bearer authentication is required.
- A request contains `1..5` reports and receives `202 { accepted, requestId }`.
- Both sides enforce field lengths, batch/body bounds, and credential redaction.
- The server derives user/session-device identity from auth rather than trusting client fields.
- The server rate-limits by authenticated device and writes structured `client.error` records to
  its normal logger.

## Relevant Files

- [../../src/main.ts](../../src/main.ts)
- [../../src/api/client.ts](../../src/api/client.ts)
- [../../src/settings/data.ts](../../src/settings/data.ts)
- [../../src/types/protocol.ts](../../src/types/protocol.ts)
- `../../src/diagnostics/client-error-reporter.ts`
- [../../docs/server-contract.md](../../docs/server-contract.md)
- [Server companion task](../../../server/AGENTS/tasks/client-error-reporting.md)

## Next Steps

1. Release plugin `1.2.24`.
2. After plugin rollout, trigger one controlled client error and confirm its structured log correlation in
   production without exposing credentials.

## Completed

- Added a 25-entry durable outbox in `data.json`, five-minute duplicate aggregation, batches of at
  most five, automatic auth/network recovery flush, and capped retry backoff.
- Captures error scope/message/stack/code/status/request ID plus plugin/Obsidian/platform/runtime,
  installation, active-path, room, queue, and preceding breadcrumb context.
- Added symmetric client/server credential redaction and strict schemas that reject unknown fields.
- Reporter delivery logs use the `diagnostics` scope and are never re-captured, preventing feedback
  loops.
- Propagated `X-Rolay-Request-Id` through REST and all blob transport fallbacks.
- Added authenticated server ingestion, server-derived actor/device identity, per-device rate
  limiting, and structured Pino error records.
- Deployed server support in production commit `a23133e` on 2026-07-30.
- Verified plugin `check`, tests, production build, server tests, and server typecheck on
  2026-07-30.

## Exit Criteria

- A plugin error reaches a structured server log with client/server correlation data.
- Repeated equal errors are aggregated.
- Offline/pre-auth errors persist and send later.
- No credential or note-body fields are accepted or emitted.
- Reporter failure does not affect room sync or generate recursive reports.
- Plugin and server tests/type-check/build pass.
