# Mobile Transport Foundation

Status: IN_PROGRESS
Priority: High
Last updated: 2026-07-28

## Goal

Establish a verified HTTPS/WSS transport and lifecycle foundation so Rolay behaves correctly on
desktop and Android/mobile before healthy-state indicators are made quieter.

## Current Understanding

- `manifest.json` declares `"isDesktopOnly": false`, so mobile behavior is a supported contract.
- The working plugin now normalizes the fixed main sync authority to `https://rolay.ru`; merge/load
  keeps existing sessions, rooms, caches, and vault state intact.
- Authenticated REST uses Obsidian `requestUrl`.
- SSE uses Node HTTP(S) on desktop and browser streaming `fetch` when Node is unavailable.
- Binary transfers prefer Electron/Node on desktop and fall back to XHR/fetch.
- Markdown realtime uses the Hocuspocus websocket provider and therefore needs a verified WSS URL.
- The updater uses `DataAdapter`, but its best-effort soft reload calls internal Obsidian plugin APIs.
- The working server now has explicit configurable CORS for known Obsidian app origins and only the
  methods/headers required by plugin browser transports.
- Server commit `978f311` is deployed at `https://rolay.ru`.
- A 2026-07-28 live probe confirmed that `https://rolay.ru/v1/auth/me` reaches the authenticated API,
  returns the expected `401` without credentials, and grants the required CORS permission to
  `app://obsidian.md`.
- The production preflight accepts bearer, SSE-resume, range, and client-version headers; an unknown
  web origin receives no `Access-Control-Allow-Origin`.
- `https://rolay.ru/v1/plugin-updates/latest` now serves the verified current GitHub release.

## Relevant Files

- [../../src/settings/data.ts](../../src/settings/data.ts)
- [../../src/api/client.ts](../../src/api/client.ts)
- [../../src/sync/event-stream.ts](../../src/sync/event-stream.ts)
- [../../src/sync/settings-stream.ts](../../src/sync/settings-stream.ts)
- [../../src/sync/note-presence-stream.ts](../../src/sync/note-presence-stream.ts)
- [../../src/realtime/crdt-session.ts](../../src/realtime/crdt-session.ts)
- [../../src/main.ts](../../src/main.ts)
- [../../src/update/plugin-updater.ts](../../src/update/plugin-updater.ts)
- [../context/ambient-sync-experience.md](../context/ambient-sync-experience.md)
- [../ideas/candidate/cross-platform-reliability.md](../ideas/candidate/cross-platform-reliability.md)
- [Server entry point](../../../server/src/app.ts)
- [Server companion AGENTS](../../../server/AGENTS/AGENTS.md)

## Progress Notes

- 2026-07-28: Audited the client transport fallbacks and identified raw HTTP plus browser
  streaming/CORS as the main unverified mobile boundary.
- 2026-07-28: Confirmed that the HTTPS reverse proxy reaches the authenticated REST API.
- 2026-07-28: Confirmed that the probed response does not currently expose CORS headers.
- 2026-07-28: Recorded mobile parity and lifecycle requirements in the product context and idea
  backlog.
- 2026-07-28: Migrated normal plugin sync to `https://rolay.ru`; insecure CRDT WSS and blob fallback
  targets are rejected.
- 2026-07-28: Added strict server CORS defaults for `app://obsidian.md`,
  `capacitor://localhost`, `ionic://localhost`, and local WebView HTTP(S) origins. Wildcard origin and
  credentials are not enabled.
- 2026-07-28: Added platform/origin/transport diagnostics, generation-safe immediate SSE reconnect, and
  Node response destruction on abort so stale sockets cannot continue after stop/reconnect.
- 2026-07-28: Added Android background CRDT presence cleanup and visible/online recovery that
  restarts only already-active rooms and rebinds the active note.
- 2026-07-28: Added lower mobile network/memory pressure defaults: four-document/256 KiB Markdown
  batches, 1 MiB upload chunks, and one binary download worker.
- 2026-07-28: Updated the vulnerable transitive WebSocket dependency; plugin `npm audit` now reports
  zero vulnerabilities.
- 2026-07-28: Server typecheck and all 33 server tests pass, including CORS allow/reject coverage;
  plugin typecheck/build pass.
- 2026-07-28: Deployed server commit `978f311`; live readiness, update discovery, allowed-origin
  response, preflight, and rejected-origin probes all passed.

## Open Questions / Risks

- What origin does the current Android Obsidian WebView send for plugin `fetch`, XHR, and websocket
  requests?
- Does Android Obsidian permit streaming response bodies reliably for long-lived SSE?
- Can Obsidian `requestUrl` expose a streaming body? If not, browser fetch or a different transport
  remains necessary for SSE.
- How aggressively does Android suspend timers, sockets, and active transfers in the background?
- Does mobile expose enough internal plugin-manager API for soft reload, or should restart be the
  normal updater outcome there?
- The plugin and server worktrees already contain uncommitted self-update and documentation changes;
  do not mix a release or broad refactor into the transport migration.

## Next Steps

1. Publish updater-enabled HTTPS plugin release `1.2.17`.
2. Run the diagnostic build on a real Android device and confirm the actual origin and
   `transport=fetch` SSE opens.
3. Verify HTTPS routes for durable SSE, settings SSE, note-presence SSE, blob upload/download, and
   CRDT token/WSS from Android.
4. Exercise cold launch, offline launch, network switch, suspend/resume, process kill during partial
   transfer, CRDT reconnect, disconnect isolation, and updater restart fallback on desktop and
   Android.
5. Keep raw `3000/tcp` ingress available until older plugin builds have updated; close it only after
   rollout verification.

## Exit Criteria

- All REST, SSE, blob, and CRDT traffic uses HTTPS/WSS on new and migrated installations.
- Desktop and Android pass the transport matrix without depending on Node/Electron on mobile.
- Suspend/resume and network switching recover automatically without duplicate creates/transfers.
- Disconnect still aborts only the selected room on every platform.
- Platform/transport diagnostics are sufficient to identify the first failing layer.
- Updater behavior on mobile is verified, with an explicit restart fallback when soft reload is not
  available.
