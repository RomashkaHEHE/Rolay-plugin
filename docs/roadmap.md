# Rolay Plugin Roadmap Notes

This file is intentionally short and practical. It tracks the next non-trivial improvements that matter for correctness and product maturity.

## Current Priority

### 1. Resumable Binary Upload/Download And Crash Recovery

Current state:

- live binary transfer progress is already byte-based
- uploads can be canceled safely
- failed/pending uploads are replayed after the next room refresh/connect
- missing or outdated downloads are re-fetched after the next authoritative snapshot

Important limitation:

- the plugin does **not** yet resume file transfer from a byte offset after restart
- in-flight `BinaryTransferState` is runtime-only
- persisted `pendingBinaryWrites` let the plugin retry later, but that is a replay from zero, not true resumable transfer

Server handoff:

- [../info-for-server/FILE_TRANSFER_RESUME_TASK.md](../info-for-server/FILE_TRANSFER_RESUME_TASK.md)

Expected client work after server support lands:

- persist active binary transfers in plugin data
- keep partial downloads in temp files
- resume uploads from server-reported `uploadedBytes`
- resume downloads through ranged requests
- restore progress UI after restart instead of showing only a fresh retry

## Next Candidates

### 2. Multi-Pane Note Presence

Current state:

- note presence works for the active markdown note in a client/window
- invisible tabs do not count as viewers, which is correct

Known limit:

- two simultaneously visible panes in one Obsidian window do not yet publish two independent viewer presences

### 3. Hardening Session Storage

Current state:

- session credentials still live in plugin data for MVP speed

Desired direction:

- move secrets to OS-level secure storage or another safer desktop-backed store

### 4. Large-Room Scaling

Potential work:

- smarter background scheduling for heavy binary rooms
- more selective preload policies
- better prioritization between active note work and bulk room hydration

### 5. Conflict Center

Potential work:

- explicit surfacing of saved conflict copies
- clearer recovery/compare tools when local and remote binary revisions diverge
