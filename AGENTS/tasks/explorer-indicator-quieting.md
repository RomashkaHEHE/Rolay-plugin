# Explorer Indicator Quieting

Status: RELEASE READY
Priority: High
Last updated: 2026-08-02

## Goal

Make Rolay's file-explorer decorations readable on demand without letting healthy room, presence,
or routine transfer state compete with filenames.

## Current Understanding

- The 2026-08-02 `Main` vault screenshot showed the connected room square and single-viewer circle
  acting like primary accents even though they represented routine state.
- This is a presentation problem, not a reason to remove state, percentages, aggregation, or
  diagnostics.
- A compact resting mark plus row-hover emphasis and a precise tooltip gives progressive disclosure
  without requiring a settings page.

## Implementation

- Replaced the room-root pseudo-square, glow, and side rail with a real trailing status dot.
- Reduced explorer presence, anonymous-viewer, and transfer badge size, saturation, border contrast,
  weight, and default opacity; increased separation from filenames and tightened spacing between
  adjacent Rolay indicators.
- After the first visual review, raised the resting opacity slightly and increased the room-status
  dot from `0.4rem` to `0.46rem` without restoring the previous glow or visual weight.
- File/folder row hover restores indicator opacity.
- Added informative room/presence/anonymous/transfer tooltips through Obsidian's `setTooltip` API
  with a `140 ms` delay, while retaining ARIA labels. This avoids both accidental fly-over popups
  and the roughly half-second wait of native browser `title` text.
- Kept tooltip copy state-only: `Connected`, `Viewers: N`, `Public readers: N`, and concise
  upload/download state plus percentage. Do not turn these compact popups into explanations.
- Softened red/yellow path text and side rails without changing when download/upload state appears.
- Bumped the plugin to `1.2.26`; the final visual and tooltip copy were approved for release.

## Relevant Files

- `styles.css`
- `src/main.ts`
- `manifest.json`
- `AGENTS/context/ambient-sync-experience.md`
- `AGENTS/ideas/candidate/ambient-sync-indicators.md`

## Verification

- `npm test` passes all 18 tests; `npm run check` and `npm run build` pass.
- Installed `main.js`, `manifest.json`, and `styles.css` into vault `Main`; all installed SHA-256
  values match the worktree build.
- Backed up the previous runtime files under
  `.rolay-update/manual-backup-1.2.25-before-1.2.26-20260802` without touching `data.json`, logs,
  caches, or room bindings.
- During testing, the production updater still reported `1.2.25`. Its comparison installs only when
  `latest > current`, so it did not downgrade or overwrite the local `1.2.26` build.
- Vault `Main` also had BRAT startup updates enabled for `RomashkaHEHE/Rolay-plugin`. The installed
  BRAT implementation coerces both manifests to semver and writes an update only when
  `localVersion < releaseVersion`; it therefore also left local `1.2.26` above the then-current
  release `1.2.25` untouched. No BRAT setting or user preference was changed.
- Obsidian initially continued displaying `1.2.25` because that instance started before the runtime
  files were copied. It was then closed through two normal `CloseMainWindow` lifecycle steps
  (settings first, main window second) and reopened without force-killing the process.
- The restarted runtime logs `Plugin version 1.2.26 is current`; room tree, CRDT, SSE, and presence
  resumed successfully. The final visual balance and concise popup copy were user-approved.

## Next Steps

1. Publish the plain-semver tag and GitHub release for `1.2.26`.
2. Verify all release assets, archive members, and production updater bytes against the tag.

## Exit Criteria

- Healthy explorer state reads as filenames first and Rolay state second.
- Deliberate glance/hover still reveals every relevant indicator and exact tooltip.
- Active and queued transfer percentages remain truthful and visible.
- GitHub release assets and production updater bytes match the plain-semver `1.2.26` tag.
