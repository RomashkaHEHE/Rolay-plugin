# Self Update

Status: IN_PROGRESS
Priority: High
Last updated: 2026-07-28

## Goal

Let installed Rolay clients detect a newer plugin release without BRAT, show a persistent outdated-version indicator, and install a verified update on explicit user action.

## Current Understanding

- Existing clients need one final BRAT/manual release containing the updater. Older code cannot discover a feature it does not have.
- Update discovery must work before authentication.
- The Rolay server is the update authority and proxies a strict allowlist of GitHub Release assets.
- Only `main.js`, `manifest.json`, and `styles.css` may be replaced.
- `data.json`, logs, caches, room bindings, and vault content must never be replaced by the updater.
- Files must be downloaded to staging, then checked for plugin ID, version, size, and SHA-256 before installation.
- A running `main.js` remains in memory after the file on disk changes. A best-effort soft reload may use Obsidian's internal plugin manager, with an explicit restart fallback.
- Update checks must start after plugin load and must not delay Obsidian startup.

## Relevant Files

- [../../src/main.ts](../../src/main.ts)
- [../../src/api/client.ts](../../src/api/client.ts)
- [../../src/settings/tab.ts](../../src/settings/tab.ts)
- [../../src/types/protocol.ts](../../src/types/protocol.ts)
- [../../styles.css](../../styles.css)
- [../../docs/server-contract.md](../../docs/server-contract.md)
- [../context/settings-and-release.md](../context/settings-and-release.md)
- [Server companion task](../../../server/AGENTS/tasks/plugin-update-distribution.md)

## Progress Notes

- 2026-07-28: Chose a server-authoritative, public read-only update manifest and file proxy. The client will never execute an unverified or partial download.
- 2026-07-28: Implemented hourly non-blocking checks against the dedicated HTTPS authority `https://rolay.ru`.
- 2026-07-28: Added strict manifest validation, byte-size/SHA-256 checks, staging, on-disk verification, two retained backups, partial-install rollback, and `manifest.json`-last replacement.
- 2026-07-28: Added a hidden-until-stale ribbon indicator, settings banner, General version/check card, confirmation modal, progress, and restart-required state.
- 2026-07-28: Added best-effort soft reload only when Obsidian exposes `disablePlugin`, `loadManifests`, and `enablePlugin`; otherwise the installed update waits for restart.
- 2026-07-28: `npm run check` and `npm run build` pass.
- 2026-07-28: Deployed server update distribution in commit `978f311`; the public production
  endpoint successfully verifies and serves release `1.2.16`.

## Open Questions / Risks

- Obsidian's programmatic plugin reload API is internal and may differ by version. Installation must remain successful even when reload is unavailable.
- Reload must not discard local state. Persist state before replacement and let the normal plugin unload lifecycle stop streams/transfers.
- A live two-version Obsidian update still needs to confirm the internal soft-reload path. Restart fallback is already implemented.

## Next Steps

1. Publish `1.2.17` as the final BRAT-delivered updater-enabled bootstrap release.
2. Publish a second test release and verify stale indicator, force update, soft reload, and restart fallback in Obsidian.
3. Mark this task `DONE` after the live two-version test.

## Exit Criteria

- An older updater-enabled build detects a newer release without login.
- The ribbon/settings UI clearly reports that the version is outdated.
- Clicking the action downloads and verifies all files before replacing anything.
- Hash/size/plugin-ID/version failures leave the installed plugin untouched.
- Successful installation either reloads Rolay or clearly asks for an Obsidian restart.
