# Git stash policy (multi-agent repo)

`~/coding/hapi` and its worktrees are touched by **multiple peer Cursor agents concurrently**. `git stash` in this environment is a silent way to lose other agents' uncommitted work.

This doc is the long-form of `.cursor/rules/no-stash-others-work.mdc`.

## Real incidents this is designed to prevent

| Date | Loss |
|------|------|
| 2026-05-31 | Watch-script ouroboros guard edit reverted twice between turns (peer ran rebuild -> auto-stashed -> never restored). Eventually committed as `a5c0fd0`. |
| 2026-05-30 | Stash list grew to 16 entries, several with names like `wip-unrelated-before-driver-rebuild` that no agent could claim ownership of. |
| various | `hapi-sync-fork-main` and `hapi-driver-rebuild` warnings prompt agents to `git stash` to proceed - they do, then forget. |

## The rule, in three lines

1. **Never stash dirty files that you did not edit this turn.**
2. **Commit your own work in-turn** (WIP commit on a branch is fine - stash is not).
3. **If something is in the way and is not yours, use a worktree** (`hapi-worktree-create`) instead of stashing the primary tree.

## Why agents stash in this repo (and what to do instead)

### "The rebuild script asked me to stash"

`hapi-driver-rebuild` will warn about a dirty driver tree, and `hapi-sync-fork-main` checks primary main. They do **not** auto-stash. If you hit the warning:

```
WARNING: /home/heavygee/coding/hapi has local changes - rebuild will reset...
```

The correct moves, in order of preference:

1. `git status` -> recognise the files. If yours, commit them. If not yours, **stop**.
2. If you cannot commit (mid-rebase, conflicting unstaged changes), move your work to a worktree:
   ```bash
   hapi-worktree-create <name> <base-branch>
   git -C ~/coding/hapi checkout -- .
   ```
3. Only stash as a last resort, with a labelled message:
   ```bash
   git stash push -u -m "wip <agent-name> <session-id> <topic>"
   ```
   ...and `git stash apply` (or `pop`) before you end your turn.

### "I need to rebase a branch but the worktree is dirty"

Rebase in the **branch's own worktree**, not in the primary `~/coding/hapi`. Every active upstream-PR branch already has a worktree under `~/coding/hapi-<name>` (`git worktree list` to confirm).

### "I am refactoring and need to checkpoint"

Make a WIP commit on a branch. Stashes are not checkpoints - they have no parent commit and no name resolution. A WIP commit can be force-pushed, amended, dropped via `git reset` - all auditable. A stash cannot.

## Backstops

| Layer | What it does |
|-------|--------------|
| Cursor rule `.cursor/rules/no-stash-others-work.mdc` | Always-applied; agents see this in their context every turn |
| `scripts/tooling/check-stash-advisory.sh` | Lists stashes older than 30 min with WIP-style labels |
| Pre-push hook | Calls the advisory script before each push; warns (does not block) |
| `install-git-hooks.sh` | Runs the advisory once at install time |

## Why not just intercept `git stash`?

Git has no `pre-stash` hook. The command path uses plumbing that bypasses commit hooks. The only way to intercept the call itself would be to replace the `git` binary in PATH with a wrapper - too invasive for a workspace-scoped policy.

So the strategy is: **in-band warning before the call** (Cursor rule) + **detection after** (advisory hook) + **commit canonical** (this doc).
