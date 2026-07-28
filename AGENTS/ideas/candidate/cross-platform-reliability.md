# Cross-Platform Reliability

Status: CANDIDATE
Priority: Highest
Last reviewed: 2026-07-28

Active task: [Mobile transport foundation](../../tasks/mobile-transport-foundation.md)

## Idea

Make desktop, Android, and other supported Obsidian platforms explicit targets with a verified
transport/lifecycle matrix instead of assuming desktop behavior transfers to mobile.

## Why It Matters

- `manifest.json` currently declares `"isDesktopOnly": false`.
- Android/mobile does not provide the Electron/Node transports used as preferred paths on desktop.
- A sync tool must survive app suspension, network switching, constrained memory, and later resume
  without duplicate work or manual recovery.
- Quiet indicators are only trustworthy after platform failures can be detected and recovered.

## Current Audit Findings

- Authenticated REST primarily uses Obsidian `requestUrl`, which is the strongest existing mobile path.
- Workspace/settings/note-presence SSE falls back to browser `fetch` when Node is unavailable.
- Binary upload/download falls back from Electron/Node to XHR/fetch.
- Markdown realtime uses the Hocuspocus websocket provider.
- The working client now uses `https://rolay.ru` for its main sync authority and rejects insecure
  CRDT/blob fallback targets.
- The working server now has a strict, configurable Obsidian-origin CORS allowlist covering bearer,
  range/content-range, SSE resume, client-version, and transfer metadata headers.
- The updater uses `DataAdapter`, but soft reload uses internal Obsidian plugin APIs and needs mobile
  verification.

The server side is now a production fact; the HTTPS/mobile plugin client still needs release and
real-device verification.

Initial live probe on 2026-07-28:

- `https://rolay.ru/` returned `200`
- `https://rolay.ru/v1/auth/me` returned the expected unauthenticated `401`, confirming that the
  HTTPS reverse proxy reaches the authenticated API
- the same request with `Origin: app://obsidian.md` returned no `Access-Control-Allow-*` headers
- `https://rolay.ru/v1/plugin-updates/latest` returned `404`, consistent with the self-update server
  work not being deployed yet

After deploying server commit `978f311` on the same date:

- `/ready` and `/v1/plugin-updates/latest` returned `200`
- `app://obsidian.md` received the expected CORS and preflight headers
- an unknown web origin received no `Access-Control-Allow-Origin`

This narrows the remaining investigation to real-device browser streaming, WSS, binary behavior,
and mobile lifecycle rather than basic HTTPS routing or server CORS deployment.

Implementation completed in the current worktree:

- HTTPS sync authority migration with existing settings/session preservation
- strict server CORS policy without wildcard origin or cookie credentials
- actual SSE transport diagnostics
- generation-safe immediate SSE reconnect and socket/body abort
- Android background presence cleanup plus visible/online recovery
- smaller mobile preload/upload batches and one binary download worker
- production dependency updates that remove all high-severity production audit findings

## Required Transport Matrix

Document and test each row on desktop and Android/mobile:

- REST/auth through Obsidian `requestUrl`
- durable tree SSE
- settings SSE
- note-presence SSE
- binary upload with progress, resume, abort, and hash verification
- binary download with range resume, progress, abort, and hash verification
- CRDT websocket over WSS
- update discovery, file replacement, rollback, and reload/restart fallback

## Server Dependencies To Validate

- Serve the complete authenticated API and websocket surface through a stable HTTPS/WSS authority.
- Confirm whether mobile WebView streaming requires CORS for its actual Obsidian origins.
- If CORS is required, allow only the methods and request/response headers used by the plugin,
  including auth, range/content-range, and Rolay diagnostic headers.
- Keep public-site and authenticated plugin boundaries explicit.

## Lifecycle Cases

- cold launch with several downloaded rooms
- app background/suspend during upload, download, preload, and CRDT editing
- app killed during partial transfer
- Wi-Fi/mobile network switch
- offline launch followed by reconnect
- token expiry while the app is suspended
- low-memory restart with persisted pending work

## Risks / Constraints

- Do not migrate the sync authority until the HTTPS domain is verified for every required route and
  websocket URL.
- Do not add permissive wildcard CORS with credential leakage risk.
- Do not remove desktop fallbacks while establishing the mobile path.
- Platform-specific concurrency limits must not change convergence semantics.
- Mobile testing needs a real Android Obsidian instance; desktop/browser simulation is insufficient.

## Good Entry Points

- server authority and device defaults in `src/settings/data.ts`
- REST/blob transport chain in `src/api/client.ts`
- SSE transports in `src/sync/event-stream.ts`, `src/sync/settings-stream.ts`, and
  `src/sync/note-presence-stream.ts`
- CRDT websocket setup in `src/realtime/crdt-session.ts`
- startup/resume/disconnect lifecycle in `src/main.ts`
- updater lifecycle in `src/update/*`
- server listener/CORS configuration in the sibling `../server` repository

## First Implementation Slice

1. Release the HTTPS/mobile client through the final BRAT bootstrap release.
2. Capture the real Android origin and transport identity from diagnostics.
3. Verify SSE, blob transfer/resume, WSS, and update behavior on the device.
4. Run cold launch, suspend/resume, reconnect, transfer-abort, and CRDT checks on desktop and Android.
