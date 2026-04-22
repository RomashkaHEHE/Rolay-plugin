# Idea Backlog

This folder is the product/backlog layer for future work.

Use it when you need to answer questions like:

- Which ideas were liked but not started yet?
- Which ideas were rejected for now, and why?
- Which ideas sound promising but still need clarification?
- What should probably be built next?

## Folder Layout

- [index.md](index.md)
  The navigation file. Read this first inside the idea backlog.
- [parallel-workflow.md](parallel-workflow.md)
  Rules for exploring multiple ideas at once on separate branches.
- `candidate/`
  Ideas the user did not reject and that look plausible to build later.
- `needs-discovery/`
  Ideas that might be useful, but still need design clarification, technical framing, or proof that the problem is real.
- `rejected/`
  Ideas explicitly declined or intentionally deferred by product direction.

## How To Use This Folder

1. Start with [index.md](index.md).
2. If parallel feature branches are active, also read [parallel-workflow.md](parallel-workflow.md).
3. Open the specific idea file before proposing or resuming work.
4. Preserve both:
   - the original idea
   - the user's reaction to it
5. Update idea files when:
   - priorities change
   - an idea is rejected or revived
   - an idea graduates into real implementation work
6. If work actually starts, create or update a file in `AGENTS/tasks/` too.

## Rule Of Thumb

- `ideas/` answers:
  "Should we do this, and what problem would it solve?"
- `tasks/` answers:
  "We are doing this now; what is the current implementation state?"
