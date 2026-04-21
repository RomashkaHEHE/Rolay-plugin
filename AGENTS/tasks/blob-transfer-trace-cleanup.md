# Blob Transfer Trace Cleanup

Status: TODO
Priority: Low
Last updated: 2026-04-22

## Goal

Reduce or gate temporary blob transfer trace logging once binary/blob transport is considered stable enough.

## Current Understanding

- Client-side blob transfer trace was added to correlate with temporary server-side blob trace.
- The client trace currently logs:
  - upload-ticket
  - upload content chunks
  - commit_blob_revision
  - download-ticket
  - blob content GET
  - final local hash after download
- Trace is controlled from:
  - `RolayPlugin.ENABLE_BLOB_TRANSFER_TRACE`

## Relevant Files

- [src/main.ts](../../src/main.ts)
- [src/api/client.ts](../../src/api/client.ts)
- [docs/debug-playbook.md](../../docs/debug-playbook.md)
- [docs/server-contract.md](../../docs/server-contract.md)

## Progress Notes

- 2026-04-22: Task documented in AGENTS layer. Trace is still intentionally enabled.

## Open Questions / Risks

- If removed too early, binary regressions become harder to debug.
- If left always-on, logs may become noisier than needed.
- A future solution may be:
  - keep the code path
  - disable it by default
  - expose a debug toggle

## Next Steps

1. Decide whether to keep trace always-on, debug-only, or runtime-toggleable.
2. If changing default behavior, update docs and release notes.
3. Make sure debug-playbook still tells agents where to look for binary failures.

## Exit Criteria

- Blob trace level is intentional and documented.
- Agents can still debug binary mismatches without depending on old chat context.
