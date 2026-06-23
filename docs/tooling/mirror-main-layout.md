# Mirror `main` layout (heavygee/hapi fork)

**Updated:** 2026-06-22

## What `~/coding/hapi` `main` is

- **Tracks `origin/main` exactly** — safe to `git pull` after PR merges; **changes land via PR**, not direct push.
- **Not** the integration branch for unmerged product features (those live in worktrees + `feat/*` branches).

## Local-first (mirror disk, not on public `origin`)

- **`docs/plans/`** — commit with `HAPI_ALLOW_OPERATOR_COMMIT=1`; pre-push blocks `origin`.
- **`localdocs/`** — gitignored.
- **Uncommitted WIP** — scripts, peer agent leftovers; commit to a branch or worktree, not mixed into a bulk `main` push.

## Backup branch (pre-tidy superset)

Before `main` was reset to `origin/main` (2026-06-22), the full local history was saved as:

```bash
git branch -a | grep mirror/pre-tidy
# mirror/pre-tidy-20260622  — 41 commits of fork integration + product work that had never pushed
```

**Do not merge the backup into `main`.** Close it with salvage closure: [`salvage-closure.md`](./salvage-closure.md) and audit [`docs/plans/2026-06-22-mirror-pre-tidy-salvage-audit.md`](../plans/2026-06-22-mirror-pre-tidy-salvage-audit.md). Responsible peers opine via briefings in `docs/plans/peer-briefings/*salvage-closure*`.

Recover a single file from backup (after peer signs disposition):

```bash
git show mirror/pre-tidy-20260622:path/to/file > path/to/file
```

Delete backup only when every cluster in the audit has a verified disposition (see audit checklist).

## Day-to-day

- **Workflow docs / tooling on `main`:** branch → PR → merge → `git pull` on mirror. **Do not push directly to `origin/main`** — even when pre-push allows it, fork hygiene is PR-only (see [`commit-hooks.md`](./commit-hooks.md)).
- **Plans / briefings:** local commit with override, or untracked; never push plans to origin
- **Product feature:** `~/coding/hapi/worktrees/<name>`
- **Soup / driver:** manifest + `driver/` worktree (rebuild only)

See [`commit-hooks.md`](./commit-hooks.md) and [`feature-work-lifecycle.md`](./feature-work-lifecycle.md).
