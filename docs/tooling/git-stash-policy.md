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

## When you do need to drop stashes — safe recipe (used 2026-06-07)

The 2026-06-07 cleanup took the list from 15 stashes -> 1 without losing
anything, by following this recipe. Use it any time you need to drop stashes
that aren't trivially yours.

### Step 1: backup every stash as a recoverable tag *before* any drop

`git stash drop` removes the stash reflog entry. The commit object lingers
in `.git/objects` until `git gc` (default: 90 days for unreachable objects,
30 days for reflog entries). That's a generous window but not infinite, and
nobody can find it without the SHA. A tag turns it into a permanent named
reference:

```bash
git stash list --format='%gd|%H|%s' | while IFS='|' read -r stash sha msg; do
    idx="${stash#stash@{}"; idx="${idx%\}}"
    git tag -f "stash-backup/$(date +%Y-%m-%d)-stash-${idx}-$(echo "$sha" | cut -c1-8)" "$sha"
done
```

After this every stash is named under `refs/tags/stash-backup/<date>-stash-<idx>-<sha8>`.
`git tag -l 'stash-backup/*'` lists them. To recover any later:

```bash
git stash apply stash-backup/2026-06-07-stash-3-c9717729   # apply the patch
git checkout -b recover stash-backup/2026-06-07-stash-3-c9717729  # branch from it
git show stash-backup/2026-06-07-stash-3-c9717729           # inspect
```

### Step 2: classify each stash by per-file blob match

For each stash, check whether each file's blob is:

- **IDENTICAL** to HEAD's blob -> no-op drop
- **LANDED elsewhere** (`git log --find-object=<blob>` finds it) -> safe to drop
- **GONE FROM HEAD** -> file was renamed/moved/deleted; check if the rename is recoverable
- **ORPHAN** (blob nowhere reachable from any branch) -> potentially lost work; inspect content

The 2026-06-07 cleanup used:

```bash
for s in $(git stash list --format='%gd'); do
    for f in $(git stash show --name-only "$s"); do
        stash_blob=$(git ls-tree "$s" -- "$f" | awk '{print $3}')
        head_blob=$(git ls-tree HEAD -- "$f" | awk '{print $3}')
        if [[ -z "$head_blob" ]]; then echo "GONE: $f"
        elif [[ "$stash_blob" == "$head_blob" ]]; then echo "IDENTICAL: $f"
        elif git log --all --find-object="$stash_blob" >/dev/null 2>&1; then echo "LANDED: $f"
        else echo "ORPHAN: $f"; fi
    done
done
```

### Step 3: check working-tree overlap before any drop

If a current dirty file matches a stash's file (by blob), the stash may be a
checkpoint of in-flight work. Leave those stashes alone. The 2026-06-07
cleanup left 1 of 15 stashes for this reason (FCM enrichment WIP in primary
worktree).

```bash
git status --porcelain | awk '{print $NF}' > /tmp/dirty
for s in $(git stash list --format='%gd'); do
    overlap=$(git stash show --name-only "$s" | grep -Fxf /tmp/dirty || true)
    [[ -n "$overlap" ]] && echo "$s overlaps: $overlap"
done
```

### Step 4: recover orphan content (with substantive value) to a commit

Plan files, design docs, or otherwise-unique-content stashes can be recovered
to a fresh commit on the right branch (fork main for `docs/plans/`, a feature
branch for code):

```bash
UNTRACKED_PARENT=$(git log -1 --format=%p stash@{N} | awk '{print $3}')
# parent3 is the untracked-files tree (only present when stash used -u)
git show "$UNTRACKED_PARENT:path/to/file" > path/to/file
git add path/to/file
git commit -m "docs(plans): recover ... from stash backup tag stash-backup/..."
```

Reference the backup tag in the commit message so future archaeologists can
find the original stash even after `git gc`.

### Step 5: drop highest-index first

Stash indexes shift down when an entry is dropped. Dropping `stash@{5}` first,
then `stash@{4}`, etc., avoids the off-by-one errors that bit the original
2026-05-31 triage (one stash was accidentally dropped because indexes shifted
mid-loop).

```bash
for s in 10 9 7 5 3; do git stash drop "stash@{$s}"; done
```

## Why not just intercept `git stash`?

Git has no `pre-stash` hook. The command path uses plumbing that bypasses commit hooks. The only way to intercept the call itself would be to replace the `git` binary in PATH with a wrapper - too invasive for a workspace-scoped policy.

So the strategy is: **in-band warning before the call** (Cursor rule) + **detection after** (advisory hook) + **commit canonical** (this doc).
