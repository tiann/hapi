# Domain Docs

This is a single-context repo.

## Before exploring, read these

- `CONTEXT.md` at the repo root, if it exists, for domain language and project context.
- `docs/adr/index.md`, if it exists, for the current ADR status map, then any relevant ADRs it points to.

If a file does not exist yet, proceed silently. Do not create domain docs unless the task calls for it.

## Use project vocabulary

When naming issues, hypotheses, tests, or refactor proposals, prefer the terms used in `CONTEXT.md` when that file exists.

If the concept you need is not in the glossary yet, note the gap instead of inventing new project language.

## Flag ADR conflicts

If a proposed change contradicts an existing ADR, surface the conflict explicitly before proceeding.
