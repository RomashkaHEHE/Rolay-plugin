# Rolay Plugin Roadmap Notes

This file is intentionally short and practical. It tracks the next non-trivial improvements that matter for correctness and product maturity.

## Current Priority

### 1. Multi-Pane Note Presence

Current state:

- note presence works for the active markdown note in a client/window
- invisible tabs do not count as viewers, which is correct

Known limit:

- two simultaneously visible panes in one Obsidian window do not yet publish two independent viewer presences

## Recently Completed

### Resumable Binary Upload/Download And Crash Recovery

- active binary transfers are persisted in plugin data
- uploads resume from `upload-ticket.uploadedBytes`
- downloads resume from `.part` files plus ranged `GET /blob/content`
- final binary materialization happens only after full size/hash verification

## Next Candidates

### 2. Hardening Session Storage

Current state:

- session credentials still live in plugin data for MVP speed

Desired direction:

- move secrets to OS-level secure storage or another safer desktop-backed store

### 3. Large-Room Scaling

Potential work:

- smarter background scheduling for heavy binary rooms
- more selective preload policies
- better prioritization between active note work and bulk room hydration

### 4. Conflict Center

Potential work:

- explicit surfacing of saved conflict copies
- clearer recovery/compare tools when local and remote binary revisions diverge
