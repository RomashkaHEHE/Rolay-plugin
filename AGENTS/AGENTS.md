# AGENTS.md

Use this file as the entry point when you work on the Rolay Obsidian plugin without prior chat history.

This repository already has canonical product/API docs in `README.md` and `docs/*`. The `AGENTS/` folder is the live handoff layer on top of those docs:

- current priorities
- design intent and rationale
- active and unfinished work
- task-by-task continuation notes
- rules for keeping agent context fresh

## Required Read Order

When starting cold, read in this order:

1. [current-state.md](current-state.md)
2. [task-protocol.md](task-protocol.md)
3. [context/README.md](context/README.md)
4. [../README.md](../README.md)
5. [../docs/repo-map.md](../docs/repo-map.md)
6. [../docs/server-contract.md](../docs/server-contract.md)
7. Relevant files in [tasks](tasks)
8. [../docs/debug-playbook.md](../docs/debug-playbook.md) if the task is bug-fixing or incident triage

## What AGENTS Must Contain

`AGENTS/` should be treated as a living operational context, not as dead documentation.

It must help a new agent answer all of these quickly:

- What matters right now?
- What was just changed recently?
- What is still unfinished?
- Which files should I open first?
- What must not be broken?
- What should I update before handing work off?

## Working Rules For Agents

1. Do not rely on old chat context as the source of truth. Use `AGENTS/`, `README.md`, `docs/*`, `git status`, and the current codebase.
2. If you start or continue a non-trivial task, update or create a task file in `AGENTS/tasks/`.
3. If you discover a new blocker, subtle invariant, or server dependency, write it down in the relevant task file before ending your turn.
4. If a change alters design intent, tradeoffs, or goals, update the relevant file in `AGENTS/context/`.
5. If a change alters stable behavior, update the canonical docs too, not only `AGENTS/`.
6. If priorities change, update [current-state.md](current-state.md).
7. Before ending substantial work, leave the next agent a clean handoff:
   - what changed
   - what remains
   - what to verify next

## Folder Layout

- [current-state.md](current-state.md)
  Live project snapshot, priorities, active work, and recently completed work.
- [context](context)
  Intent/rationale layer for major project areas and design tradeoffs.
- [task-protocol.md](task-protocol.md)
  Rules for creating/updating task files and handing work off.
- [task-template.md](task-template.md)
  Template for future task files.
- [tasks](tasks)
  One file per meaningful multi-step task or ongoing thread.

## Important Constraint

Keep `AGENTS/AGENTS.md` short and stable. Put volatile detail in `current-state.md` and `tasks/*`, and put rationale/intention in `context/*`.
