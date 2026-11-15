# Desktop And Production Sync Audit

Status: WATCH
Priority: High
Last updated: 2026-11-13

## Goal

Investigate desktop/server sync issues without overwriting divergent user content.

## Current Understanding

- Active vaults Main and Lessons run 1.2.26. Other installed test vaults have only April logs.
- Read-only authenticated tree/bootstrap audit verified Main at cursor 384: 223 active entries,
  all 142 Markdown texts and all 41 binary hashes/sizes match local files.
- Lessons at cursor 8188 has 409 active entries: all 280 binary hashes/sizes match; 94/99 Markdown
  texts match. No active path is missing in either vault.
- Five Lessons differences are exclusively wiki embed targets; all other text matches. Four are
  lectures dated 03.04, 13.03, 20.03, 27.03 under main150911/1 курс/Физика/Лекции.
  The fifth is main150911/АГиТДУ/Практики/17.04.2026(1)/17.04.2026(1).md.
- One fifth-note embed points outside the room to архив/English/attachments/image-1.png. Do not
  force overwrite or auto-publish these differences without resolving the actual link targets.
- Both vaults have empty pending creates/merges/binary writes/transfers/client-error outboxes.
  Empty outboxes do not prove divergent local Markdown is synchronized.
- Local logs show successful locked-retry downloads repeating every ~8 seconds for divergent
  notes. Hydration correctly preserves local bytes; downloads cannot resolve local divergence.
- Main invalid-refresh errors left streams unauthenticated until login at 2026-11-13T14:10:04Z.
  Code confirms an independent concurrent refresh race against single-use server tokens; retained
  logs do not establish that every observed auth failure had that cause.
- Production 24-hour Docker scan: no HTTP 5xx or server-generated warn/error records. The 29
  level-50 records are client reports, including delayed October offline reports. Most 404s are
  external probes; application 401s mostly expired access tokens.
- Readiness passes. Rolay ~88 MiB RAM, zero container restarts, root disk 46% full / 16 GiB free,
  journal ~465 MiB, Docker logs bounded at 3 x 10 MiB.

## Changes And Verification

- API refresh is single-flight; delayed old-token 401s reuse rotated credentials. Late refresh
  responses cannot undo logout or overwrite/erase a replaced session.
- Per-room local divergence tracking excludes these notes from fast locked-download retries,
  logs the cause once per episode, preserves protection, and clears on convergence. Normal
  background reconciliation still checks remote state.
- Follow-up screenshot showed local divergence still rendered as `Downloading: 100%`. Explorer
  now excludes divergent notes from both Markdown transfer aggregation paths and displays a muted
  amber `!` / `Local changes` badge using minimal-visible-parent placement. Genuine 100% pending
  work remains visible as `Sync pending` (download) or `Finalizing upload`; rounding cannot show
  100% before all tracked bytes arrive. This follow-up is not yet released.
- Follow-up verification: TypeScript, production build, all 27 tests, and whitespace checks pass.
  Runtime visual verification remains pending; no vault files were replaced for this follow-up.
- Added regression coverage for concurrent refresh, late 401, session replacement, logout,
  transient retry, local text preservation, and locked-download filtering. All 24 tests,
  TypeScript check, production build, and git diff --check pass. No vault data or server state
  was modified during the audit.

## Relevant Files

- src/api/client.ts
- src/main.ts
- src/sync/markdown-hydration.ts
- tests/auth-refresh.test.ts
- tests/markdown-hydration.test.ts
- docs/debug-playbook.md

## Release Rollout

- Published plain-semver tag 1.2.27 from commit f79b474. GitHub Actions run 43481085438 passed.
- Verified all five release assets and four zip members. Standalone files match raw tag blobs.
- All three production /v1/plugin-updates/1.2.27/files/* responses match GitHub/tag bytes and
  advertise correct version and SHA-256 headers.
- Latest discovery still returned cached 1.2.26 at verification time; normal server TTL is
  15 minutes. No server restart or cache configuration change was made.
- No manual vault installation or Obsidian restart was performed for this rollout.

## Next Steps

- Confirm latest discovery refreshes to 1.2.27 and automatic installation reaches active vaults.
- Verify auth recovery and elimination of 8-second divergent-note loops in runtime logs.
- [Portable note links](portable-note-links.md) implements conservative same-entry link-only
  reconciliation, with durable replay and source backups. Deploy and verify four safe cases;
  the fifth outside-room link and arbitrary non-link offline text edits remain protected.
- Verify the new local-change badge replaces false download percentages in the actual explorer
  after the next release; mixed folders must retain both real transfer progress and local warnings.

## Exit Criteria

- Concurrent transport recovery does not invalidate a healthy rotated session.
- Local changes survive without repeated fast downloads.
- Existing local differences receive safe reconciliation with explicit target resolution.
