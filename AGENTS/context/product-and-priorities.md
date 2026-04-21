# Product And Priorities

## What This Plugin Is For

This is not a generic public Obsidian plugin. It is a collaboration tool for a specific academic group using a specific Rolay server.

That matters because many decisions are intentionally optimized for:

- fast iteration over broad public compatibility
- correctness and recovery over minimal code size
- practical collaboration workflows over abstract purity
- developer/operator visibility over polished minimalism

## Main Product Goals

### 1. Shared work must feel safe

Users should not lose content because of timing races, late snapshots, reconnects, or temporary divergence between local and remote state.

### 2. Collaboration must feel understandable

People should be able to tell:

- who is in a note
- who is editing
- whether a file is still loading
- whether a file is being uploaded
- whether a room is connected

### 3. The system should be debuggable in real life

When something goes wrong, a developer or agent should be able to inspect logs and persisted state and reconstruct what failed first.

### 4. Private/internal distribution is acceptable

The plugin is distributed to a known group, currently through BRAT and GitHub Releases, not through a public marketplace-first process.

## Priority Order For Design Decisions

When tradeoffs are unclear, preserve these in order:

1. Data safety
2. Sync correctness
3. Collaboration clarity/UX
4. Debuggability
5. Performance
6. Code elegance

## What Not To Accidentally Optimize For

Avoid making changes that are "cleaner" but weaken any of these:

- conflict survival
- startup recovery
- explicit visibility of sync state
- ability to inspect failures from `data.json` and `rolay-sync.log`

## Implication For Future Agents

Do not preserve a particular mechanism just because it exists today.

Preserve the underlying goals:

- people must not silently lose work
- collaboration state must be visible
- bug reports must be diagnosable after the fact
