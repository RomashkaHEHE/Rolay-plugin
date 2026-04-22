# Task Protocol

This file defines how agents should keep handoff context alive.

## When To Create A Task File

Create or update a file in `AGENTS/tasks/` when a task is:

- expected to last more than one turn
- blocked on server/client coordination
- subtle enough that a future agent could repeat work without notes
- likely to leave partial progress in the tree

For tiny one-shot edits, a task file is optional.

## Required Task File Sections

Use [AGENTS/task-template.md](task-template.md).

At minimum every real task file must include:

- `Status`
- `Priority`
- `Goal`
- `Current understanding`
- `Relevant files`
- `Next steps`
- `Exit criteria`

## Status Values

Use one of:

- `TODO`
- `IN_PROGRESS`
- `BLOCKED`
- `DONE`
- `WATCH` for recently fixed areas that may still need regression observation

## Update Rules

Agents should update task files:

1. When starting work on an existing task
2. When scope changes
3. When a blocker appears
4. When server changes become required
5. When important invariants or pitfalls are discovered
6. Before handing off unfinished work
7. When a task is done

## What To Write In Task Updates

Prefer concrete notes over prose fluff. Include:

- what changed
- what was verified
- what still is not verified
- exact files touched
- any risky assumptions
- exact next action for the next agent

## Relationship To Canonical Docs

`AGENTS/tasks/*` is for live task continuity.

`README.md` and `docs/*` stay canonical for stable project truth.

`AGENTS/context/*` is for rationale, goals, and design intent.

`AGENTS/ideas/*` is for product backlog items that are not active implementation tasks yet.

If a task changes stable behavior, update both:

- the task file
- the relevant canonical docs

If a task changes why something is shaped a certain way, update the relevant file in `AGENTS/context/`.

If a product conversation changes whether an idea is approved, rejected, clarified, or reprioritized, update the relevant file in `AGENTS/ideas/`.

## Relationship To The Idea Backlog

Use this rule of thumb:

- `AGENTS/ideas/*`:
  the team is still deciding whether/how to do it
- `AGENTS/tasks/*`:
  real implementation work is underway or partially done

When starting work on an idea from `AGENTS/ideas/`:

1. Keep the idea file as the product-history record
2. Create or update a task file in `AGENTS/tasks/`
3. Link the task and idea to each other if helpful
4. If the idea has its own branch, record that branch name in the task file

When an active task is intentionally paused for product reasons, say so in both places:

- the task file
- the relevant idea file or rejected/deferred backlog note

## Required End-Of-Turn Hygiene

Before ending substantial work:

1. Update the relevant task file
2. Update [AGENTS/current-state.md](current-state.md) if priorities or active work changed
3. Update `AGENTS/context/*` if design intent or tradeoffs changed
4. Update `AGENTS/ideas/*` if backlog intent or product decisions changed
5. Update canonical docs if stable behavior changed
6. Leave the next agent enough information to continue without chat history
