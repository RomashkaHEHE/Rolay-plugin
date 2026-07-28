# Product And Priorities

## What This Plugin Is For

Rolay is an Obsidian synchronization tool that also supports live collaboration.

The academic-group workflow remains important, but it is no longer the product's only framing.
The normal experience should also work well when one person simply expects a room to stay synchronized
across devices without thinking about Rolay.

The product should optimize for:

- safe and correct synchronization
- quiet, automatic operation during healthy states
- practical collaboration when other people are present
- broad desktop and mobile reliability
- enough durable diagnostics to reconstruct failures after the fact

## Main Product Goals

### 1. Shared work must feel safe

Users should not lose content because of timing races, late snapshots, reconnects, or temporary divergence between local and remote state.

### 2. Healthy synchronization should be almost invisible

Users should open Obsidian and work normally. Routine startup, preload, retries, reconnects, downloads,
uploads, and updates should not require manual refresh buttons or repeated notices.

When one local session is the only viewer and synchronization is healthy, the interface should show
almost nothing beyond a subtle room health mark.

### 3. Collaboration must appear when it becomes useful

People should be able to tell:

- who is in a note
- who is editing
- whether a file is still loading
- whether a file is being uploaded
- whether a room is connected

These details should use progressive disclosure. Do not make users stare at collaboration and transfer
state when nothing noteworthy is happening.

### 4. The system should recover by itself

Expected transient failures should be retried, resumed, or reconciled automatically with bounded
backoff and no duplicate work. User action should be requested only when the plugin cannot recover
safely on its own.

### 5. The system should be debuggable in real life

When something goes wrong, a developer or agent should be able to inspect logs and persisted state and reconstruct what failed first.

Quiet UI must not mean missing observability. Detailed state belongs in contextual tooltips and
structured, short-lived logs even when it is not constantly visible.

### 6. Desktop and mobile are first-class targets

`manifest.json` declares the plugin mobile-compatible. Features must therefore avoid accidental
Electron/Node-only assumptions and must be verified against Android/mobile lifecycle, networking,
storage, memory, and interaction constraints.

### 7. Private/internal distribution is acceptable

The plugin is distributed to a known group, not through a public marketplace-first process. GitHub
Releases remain the artifact source; BRAT is used for initial/bootstrap installation, while
updater-enabled builds use the Rolay server for ongoing update discovery and verified delivery.

## Priority Order For Design Decisions

When tradeoffs are unclear, preserve these in order:

1. Data safety
2. Sync correctness
3. Autonomous recovery and continuity
4. Startup and runtime responsiveness
5. Calm, contextual UX
6. Debuggability
7. Code elegance

## What Not To Accidentally Optimize For

Avoid making changes that are "cleaner" but weaken any of these:

- conflict survival
- startup recovery
- automatic retry/resume behavior
- mobile compatibility
- contextual visibility of exceptional sync state
- ability to inspect failures from `data.json` and `rolay-sync.log`

## Implication For Future Agents

Do not preserve a particular mechanism just because it exists today.

Preserve the underlying goals:

- people must not silently lose work
- ordinary sync should not demand attention
- collaboration and exceptional state must become visible when useful
- recoverable failures should not become user chores
- desktop success does not prove Android/mobile support
- bug reports must be diagnosable after the fact
