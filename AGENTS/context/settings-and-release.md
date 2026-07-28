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

The plugin uses GitHub Releases as the release artifact source. Existing installations currently use BRAT, but the intended steady state is a Rolay self-updater backed by the Rolay server.

Why:

- the audience is known and limited
- fast iteration matters more than public plugin-catalog workflow
- maintainers need low-friction release steps
- clients should receive update availability without requiring every user to configure BRAT

The server is the update authority even when GitHub stores the artifacts. The client accepts only `main.js`, `manifest.json`, and `styles.css`, verifies their hashes and release metadata, and never replaces `data.json` or local sync state.

Ongoing updates are deliberately autonomous. Updater-enabled clients check shortly after startup,
every 15 minutes, and after connectivity recovery; they download and verify a newer release,
wait for sync/editor activity to reach a safe idle window, persist local state, install, and retry
temporary failures without a user action. Do not add `Refresh`, `Check for updates`, `Force update`,
or equivalent install controls back to the product UI. Normal update work is silent. Only a
required Obsidian restart or a persistent automatic-retry failure should attract attention.

Executable update traffic and normal sync now use `https://rolay.ru`. Update discovery is still a
separate public read-only surface, while room/auth/tree/blob APIs remain authenticated. The client
must reject insecure update, CRDT, or blob fallback targets rather than silently downgrading.

There is an unavoidable bootstrap boundary: clients older than the first updater-enabled release need one final BRAT or manual update.

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
