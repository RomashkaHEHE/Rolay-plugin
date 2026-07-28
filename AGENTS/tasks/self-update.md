# Self Update

Status: IN_PROGRESS
Priority: High
Last updated: 2026-07-28

## Goal

Let installed Rolay clients discover, verify, and install newer releases without BRAT or requiring
any manual refresh/check/install action.

## Current Understanding

- `1.2.17` first delivered update discovery. Clients older than that cannot discover a feature they
  do not have, while transitional `1.2.17`/`1.2.18` clients still need one explicit update to
  automatic client `1.2.19`.
- Update discovery must work before authentication.
- The Rolay server is the update authority and proxies a strict allowlist of GitHub Release assets.
- Only `main.js`, `manifest.json`, and `styles.css` may be replaced.
- `data.json`, logs, caches, room bindings, and vault content must never be replaced by the updater.
- Files must be downloaded to staging, then checked for plugin ID, version, size, and SHA-256 before installation.
- A running `main.js` remains in memory after the file on disk changes. A best-effort soft reload may use Obsidian's internal plugin manager, with an explicit restart fallback.
- Update checks must start after plugin load and must not delay Obsidian startup.
- Expected update work must be invisible and autonomous. Only restart-required or persistent retry
  failure is exceptional enough to surface.
- Installation must wait for active sync/preload/reconciliation and recent editor/vault activity to
  settle, then persist local state before replacing runtime files.

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
- 2026-07-28: Initially implemented hourly non-blocking discovery against the dedicated HTTPS
  authority `https://rolay.ru`; the automatic-install revision shortened the normal interval to
  15 minutes and added connectivity-triggered checks.
- 2026-07-28: Added strict manifest validation, byte-size/SHA-256 checks, staging, on-disk verification, two retained backups, partial-install rollback, and `manifest.json`-last replacement.
- 2026-07-28: Replaced the explicit force-update flow with automatic discovery every 15 minutes,
  automatic verified install in a safe idle window, connectivity-triggered checks, and bounded
  retry backoff.
- 2026-07-28: Removed the update modal and the old force-install flow. Healthy checks, downloads,
  waiting, and installation stay hidden; settings/ribbon surface only persistent errors and
  restart-required state.
- 2026-07-28: Added a compact optional check-now icon to `General -> Plugin Version` for release
  testing. It only schedules the existing automatic check immediately; verification, safe-idle
  waiting, install, retries, and reload behavior remain identical to background discovery.
- 2026-07-28: Added an explicit safe-install gate for active operation queue work, binary transport,
  startup/recovery, room snapshot/background reconciliation, Markdown preload, and recent
  editor/vault activity. Failed pending records remain durable across reload and do not permanently
  starve an updater that may contain their fix.
- 2026-07-28: Automatic retries use bounded backoff and accelerate after connectivity/mobile resume.
  A deliberately offline client does not turn normal offline state into a persistent update error.
- 2026-07-28: `1.2.19` type-check, production build, bundle string audit, `git diff --check`, and
  `npm audit` pass locally.
- 2026-07-28: Added best-effort soft reload only when Obsidian exposes `disablePlugin`, `loadManifests`, and `enablePlugin`; otherwise the installed update waits for restart.
- 2026-07-28: `npm run check` and `npm run build` pass.
- 2026-07-28: Deployed server update distribution in commit `978f311`; the public production
  endpoint successfully verifies and serves release `1.2.16`.
- 2026-07-28: Published stable plain-semver release `1.2.17` from commit `2017faa`; workflow,
  manifest, standalone BRAT assets, and archive contents were verified.
- 2026-07-28: Published plain-semver release `1.2.19` from commit `f3fc86a`. GitHub Actions run
  `30353663231` passed; all five release assets, the zip contents, tag blobs, production proxy bytes,
  sizes, and canonical SHA-256 values were verified. `https://rolay.ru/v1/plugin-updates/latest`
  now reports `1.2.19`.
- 2026-07-28: Published plain-semver release `1.2.20` from commit `48418f7`. GitHub Actions run
  `30381604566` passed. The five release assets and four-file archive match the tag; the production
  endpoint reports `1.2.20` and serves exact bytes for all three updater files.
- 2026-07-28: Canonical release SHA-256 values are
  `0cdf9aa7b8f5fd91e50d86d70508145331a1a398d0284ca7a3351b76acc42483` (`main.js`),
  `0dbaea63b5567a68a979f8ddb3a93522b17631cebd8f9a98a1d895b334ca9301`
  (`manifest.json`), and
  `2e2bc5dc2ca433f2e7951d267f5fefbbf3ddb068cf563858d4ec32912215db22`
  (`styles.css`).

## Open Questions / Risks

- Obsidian's programmatic plugin reload API is internal and may differ by version. Installation must remain successful even when reload is unavailable.
- Reload must not discard local state. Persist state before replacement and let the normal plugin unload lifecycle stop streams/transfers.
- A live two-version Obsidian update still needs to confirm the automatic safe-idle install and
  internal soft-reload path. Restart fallback is already implemented.

## Next Steps

1. Move existing `1.2.17`/`1.2.18` clients to `1.2.19` once through their existing explicit updater
   or BRAT.
2. Verify automatic `1.2.19 -> 1.2.20` discovery, safe-idle waiting, download, installation, retry,
   soft reload, and restart fallback in Obsidian.
3. Mark this task `DONE` after the live two-version test.

## Exit Criteria

- An older updater-enabled build detects a newer release without login.
- A newer release downloads and installs without any user action.
- Active sync work is allowed to finish before runtime replacement/reload.
- Hash/size/plugin-ID/version failures leave the installed plugin untouched.
- Temporary failures retry automatically without notices or buttons.
- Successful installation either reloads Rolay or clearly asks for an Obsidian restart.
