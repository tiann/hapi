# Mirror `main` layout (heavygee/hapi fork)

**Updated:** 2026-06-22

## What `~/coding/hapi` `main` is

- **Tracks `origin/main` exactly** — safe to `git pull` / `git push` for GitHub-visible docs and tooling.
- **Not** the integration branch for unmerged product features (those live in worktrees + `feat/*` branches).

## Local-first (mirror disk, not on public `origin`)

- **`docs/plans/`** — commit with `HAPI_ALLOW_OPERATOR_COMMIT=1`; pre-push blocks `origin`.
- **`localdocs/`** — gitignored.
- **Uncommitted WIP** — scripts, peer agent leftovers; commit to a branch or worktree, not mixed into a bulk `main` push.

## Backup branch (pre-tidy superset)

Before `main` was reset to `origin/main` (2026-06-22), the full local history was saved as:

```bash
git branch -a | grep mirror/pre-tidy
# mirror/pre-tidy-20260622  — 45 commits of fork integration + product work that had never pushed
```

Recover a file from that branch:

```bash
git show mirror/pre-tidy-20260622:path/to/file > path/to/file
```

## Day-to-day

| Task | Where |
|------|-------|
| Edit workflow docs | `main` → push `origin/main` |
| Edit plans / briefings | `main` local commit (override) or untracked; never push plans |
| Product feature | `~/coding/hapi/worktrees/<name>` |
| Soup / driver | manifest + `driver/` worktree (rebuild only) |

See [`commit-hooks.md`](./commit-hooks.md) and [`feature-work-lifecycle.md`](./feature-work-lifecycle.md).
