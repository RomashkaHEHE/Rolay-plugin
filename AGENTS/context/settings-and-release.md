# Settings And Release

## Settings UX Intent

The settings UI is meant to be task-oriented, not a dump of all state.

That is why it is split into:

- `Rooms`
- `Account`
- `General`
- `Admin`

And why room detail/admin detail pages behave like drill-down pages instead of endlessly expanding one giant screen.

## Why Some Information Is Hidden Or Secondary

The user should mainly see controls they can actually use.

That is why:

- account login fields disappear when already authenticated
- room-specific actions sit on the room detail page
- some technical info is better placed in a debug/details section than in the main path

## Distribution Intent

The plugin is distributed internally via GitHub Releases and BRAT.

Why:

- the audience is known and limited
- fast iteration matters more than public plugin-catalog workflow
- maintainers need low-friction release steps

## Release Convention Intent

Plain semver tags like `1.2.5` are preferred because:

- they match `manifest.json`
- BRAT/Obsidian tooling expects version alignment
- they avoid confusion around `v`-prefixed tag lookup

## AGENTS Intent

The `AGENTS/` layer exists because canonical docs alone are not enough for continuation work.

Canonical docs explain:

- what exists
- what the protocol is
- how the repo is laid out

The `AGENTS/` layer explains:

- current priorities
- unfinished work
- why current tradeoffs were chosen
- what future agents must preserve even if they rework the implementation
