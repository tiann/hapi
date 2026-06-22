# Salvage closure — §0 reverse (fork mirror tidy)

**Last updated:** 2026-06-22  
**Audience:** Operator, orchestrators — after saving a pre-tidy backup branch (see [`mirror-main-layout.md`](./mirror-main-layout.md)).

Intake [`new-feature-intake.md` §0](./new-feature-intake.md#0--feature-peer-agent--mandatory-handoff) is **spawn handoff (forward)**. This doc is **closure handoff (backward)**: before deleting a backup branch, each feature cluster gets a signed disposition from the responsible peer (or operator).

---

## When to run

- Mirror `main` was reset to `origin/main` and history was saved (e.g. `mirror/pre-tidy-20260622`).
- You need to know whether backup commits are **redundant**, **migrated**, **salvage**, or **abandoned** before `git branch -d mirror/pre-tidy-*`.

Do **not** merge the backup branch back into `main`. Cherry-pick only after a peer signs `SALVAGE` and orchestrator verifies the file is missing everywhere else.

---

## Workflow

1. **Orchestrator buckets** backup commits into feature clusters (~6–8), not one prompt per commit.
2. **Build evidence bundle** per cluster (commits, path diff, alternate branch/PR, transcript id).
3. **Resume or respawn** the originating peer with the closure template below (or operator signs if origin unknown).
4. **Orchestrator verifies** proof commands — do not accept peer `REDUNDANT` without running them.
5. **Record** dispositions in `docs/plans/<date>-mirror-pre-tidy-salvage-audit.md` (local-first).
6. **Delete backup branch** only when every cluster has a verified disposition.

Finding the originating agent:

```bash
rg -l '<issue-or-slug>' ~/.cursor/projects/*/agent-transcripts/*/*.jsonl
git branch -a --contains <commit>
git log --oneline --all --grep='<#NNN>'
```

Peer briefings for copy-paste spawn prompts: [`docs/plans/peer-briefings/`](../plans/peer-briefings/) — files named `*-salvage-closure-*.md`.

---

## Closure template (paste to responsible peer)

```markdown
## Salvage audit — <cluster slug>

**Backup ref:** mirror/pre-tidy-20260622
**Commits:** <hashes + subjects>
**Paths:** `git diff main..mirror/pre-tidy-20260622 -- <paths>`
**Alternate homes:** <branch / PR / upstream merge — with proof commands>
**Your session (if known):** <cursor-session-id>

Reply with ALL four sections. Audit only — do not re-implement unless disposition is SALVAGE and file is absent elsewhere.

### 1. Root cause
Why did this sit on mirror `main` / never push? (one paragraph)

### 2. Current truth
Where does this work live *now*?

### 3. Disposition — pick ONE
- `REDUNDANT` — superseded; backup discardable (cite merge commit / PR)
- `MIGRATED` — lives on branch/PR; backup slice discardable
- `SALVAGE` — still missing; list commits to cherry-pick
- `ABANDON` — operator chose not to ship; why

### 4. Prevention
One concrete habit change (worktree-only, `tooling/*` branch, no mirror-main integration commits, etc.)
```

---

## Dispositions

- **REDUNDANT** — canonical copy exists elsewhere. Proof: `git merge-base --is-ancestor <commit> upstream/main` or squash on `origin/main`.
- **MIGRATED** — fork work on a named branch. Proof: `git branch -a --contains <commit>` and diff vs backup empty on that branch.
- **SALVAGE** — still needed, not on any branch. Cherry-pick to `tooling/*` or feature branch; re-verify.
- **ABANDON** — conscious drop. Operator note in audit; no cherry-pick.

---

## Related

- [`mirror-main-layout.md`](./mirror-main-layout.md) — backup branch + mirror `main` contract
- [`commit-hooks.md`](./commit-hooks.md) — why bulk push failed (fork-private paths)
- [`feature-work-lifecycle.md`](./feature-work-lifecycle.md) — forward workflow; do not duplicate here
- [`new-feature-intake.md` §0-closure](./new-feature-intake.md#0-closure--salvage-audit-reverse-handoff) — one-line pointer from intake
