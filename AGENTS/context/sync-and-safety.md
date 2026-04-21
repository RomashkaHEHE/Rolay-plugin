# Sync And Safety

## Core Sync Philosophy

The plugin uses different sync models for different content types on purpose.

### Markdown

Markdown uses CRDT/Yjs because:

- it is collaboratively edited in real time
- merges should be structural and low-friction
- multiple users may type concurrently

### Everything Else

All non-`.md` files use binary/blob sync because:

- they are not collaboratively mergeable in the same way
- pretending they are text creates false safety
- binary transfer can be reasoned about in hashes, sizes, and revisions

## Server-Authoritative Tree

The tree is server-authoritative by design.

Why:

- it prevents each client from inventing its own truth about creates/renames/deletes
- it gives a single source of truth for recovery after reconnect/restart
- it reduces recursive echo bugs like "remote create becomes local create becomes remote create"

## Why So Many Guards Exist

The plugin contains protective logic that may look conservative:

- pending local create markers
- pending binary write markers
- protected remote binary placeholders
- loading/protected file states
- optimistic local tree updates after confirmed ops
- conflict-copy behavior

These exist because past failures were caused by races such as:

- file appears before bytes arrive
- stale snapshot deletes a newly recreated file
- remote placeholder is mistaken for a local user modification
- quick move-out / move-back cycles destroying content

## Important Safety Intent

If something is not fully hydrated yet, the system should bias toward blocking risky local actions rather than allowing silent data loss.

Examples:

- downloading binary files are protected from delete/move
- markdown still waiting for safe preload can be visually marked and treated conservatively

## Conflict Philosophy

When local and remote realities diverge, the preferred outcome is usually:

- keep both copies alive
- rename one side predictably
- never silently overwrite local user work if avoidable

This is why explorer-style conflict naming like `file(1).ext` exists.

## Implication For Future Changes

Before removing a guard or simplifiying a sync path, ask:

- What failure mode was this protecting against?
- If this fails now, does the user lose work or just see a recoverable inconvenience?

If the answer includes silent data loss, keep the guard or replace it with an equally safe mechanism.
