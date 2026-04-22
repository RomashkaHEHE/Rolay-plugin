# Parallel Idea Workflow

Use this file when several ideas are being explored in parallel on separate branches.

## Why This Exists

Parallel branches are useful here because many backlog ideas are UX-heavy and partially independent.

The goal is to:

- explore faster
- avoid one large unstable branch
- keep product decisions attached to the right idea
- make it easy for a fresh agent to continue the correct branch without old chat context

## Default Rule

One substantial idea branch should usually mean:

- one idea file in `AGENTS/ideas/*`
- one task file in `AGENTS/tasks/*`
- one focused branch

Avoid mixing multiple major ideas into the same feature branch unless they are tightly coupled.

## Recommended Branch Naming

Use predictable names like:

- `idea/follow-mode`
- `idea/unread-remote-changes`
- `idea/room-install-progress`
- `idea/notification-polish`

This makes it obvious which idea file and task file belong to the branch.

## Required Files When Starting A Branch

If work starts on an idea branch:

1. Keep the idea file in `AGENTS/ideas/` as the product-intent record.
2. Create or update `AGENTS/tasks/<idea-name>.md` as the implementation record.
3. Set task status to `IN_PROGRESS`.
4. In the task file, record:
   - branch name
   - scope chosen for this branch
   - what is intentionally out of scope

## Scope Discipline

On idea branches:

- prefer vertical slices over giant partial rewrites
- try to produce something demoable
- keep refactors scoped to what the idea really needs

If a branch starts needing unrelated cleanup, write that down separately instead of silently absorbing it.

## Moving Ideas Between States

Typical path:

1. `AGENTS/ideas/candidate/...`
2. branch starts
3. `AGENTS/tasks/...` created or updated
4. if shipped, update canonical docs and current state
5. if abandoned, update the idea file with why it stopped

## If Two Branches Touch The Same Area

Do this explicitly:

- note the overlap in both task files
- identify the shared files
- decide which branch is authoritative for that area

Examples of overlap-prone areas:

- `src/main.ts`
- `src/realtime/shared-presence.ts`
- `src/settings/tab.ts`
- `styles.css`

## Recommended First Parallel Batch

Given the current backlog, these branches are the best first batch because they are valuable and only moderately coupled:

1. `idea/unread-remote-changes`
2. `idea/follow-mode`
3. `idea/room-install-progress`

Second batch candidates after that:

1. `idea/notification-polish`
2. `idea/room-health-badge`
3. `idea/per-file-status-detail`

## Handoff Rule

Before pausing or leaving a branch:

1. Update the branch's task file in `AGENTS/tasks/`
2. Update the idea file if product understanding changed
3. Update `AGENTS/current-state.md` only if overall project priorities changed
