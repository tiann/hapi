# Agent Tooling — Meta Bot Charter

This directory is the **canonical contract** for repo, testing, and dev maintenance across active agents on the HAPI hub and adjacent projects on this machine.

**Meta bot** = the agent (or session) explicitly tasked with keeping this contract accurate, the machine helpers working, and feature agents from stepping on each other.

Feature agents should **read the relevant doc below at session start**; meta bot reads **all of them** and fixes drift.

---

## Scope

| Layer | What | Meta bot owns |
|-------|------|----------------|
| **HAPI API / hub** | `~/coding/hapi` (upstream/main mirror), `~/coding/hapi-driver` (daily soup), `~/coding/hapi-*` PR worktrees, `hapi-active` symlink | Driver manifest rebuild, worktree hygiene, live swing |
| **Adjacent HAPI repos** | e.g. `hapi-garden`, `hapi-session-attention`, any `~/coding/hapi-*` worktree with an open branch | Same rules; confirm which tree is active before debugging "prod" |
| **Machine helpers** | `~/.local/bin/hapi-use-worktree`, `hapi-use-main`, `gh` wrapper, `pr-post-push-check*`, `~/.local/bin/hapi-sessions-health.sh` → `server-setup/scripts/hapi/` | Installed, executable, match docs |
| **Agent hooks** | `~/.claude/settings.json`, `~/.cursor/hooks.json`, `~/coding/AGENTS.local.md` | Policy text matches docs; note IDE vs CLI hook parity gaps |
| **Upstream boundary** | `tiann/hapi` PRs | No operator-local files; **disclose AI model** in PR body per upstream `CONTRIBUTING.md` (post-#727); see repo `AGENTS.local.md` for the `## Disclosure` template |

**Not in scope for meta bot by default:** unrelated repos with no HAPI session unless the operator assigns them.

---

## Tooling index

| Doc | Purpose |
|-----|---------|
| [new-feature-intake.md](./new-feature-intake.md) | **Operator requests new behavior** — discovery, playback, soup vs clean demo, gates before dogfood, PR after approval |
| `scripts/tooling/hapi-sync-fork-main.sh` | Keep `~/coding/hapi` `main` = upstream + fork docs |
| [commit-hooks.md](./commit-hooks.md) | `install-git-hooks.sh` — secrets + operator path gates |
| [git-stash-policy.md](./git-stash-policy.md) | **Multi-agent repo** - do not stash other agents' work; commit instead |
| [worktree-testing.md](./worktree-testing.md) | `hapi-active` symlink, `hapi-use-worktree`, service swing |
| [driver-soup.md](./driver-soup.md) | Daily driver manifest, merge-train PR worktrees, garden vs soup |
| [watch-activate-driver.md](./watch-activate-driver.md) | `hapi-watch-activate-driver` - external-only watch; ouroboros guard + excludes |
| [pr-review-loop.md](./pr-review-loop.md) | Pre-PR verification + cold review; pre-push open-PR gate; post-push PR comment poll |
| [pr-reply.md](./pr-reply.md) | `hapi-pr-reply` — atomic reply + `resolveReviewThread` for PR review comments. Mandatory for bot/reviewer thread responses (never `gh pr comment` for that) |
| [cold-pr-review-rubric.md](./cold-pr-review-rubric.md) | Open-PR cold review bar (match upstream HAPI Bot severity) |

---

## Meta bot responsibilities

### 1. Worktree and live hub discipline

- `~/coding/hapi` primary checkout tracks **upstream/main** (mirror) — not the daily driver.
- `~/coding/hapi-driver` is the **bleeding-edge soup** on `:3006` via `hapi-active` (see [driver-soup.md](./driver-soup.md)).
- **`hapi-driver` is read-only between rebuilds** — only `hapi-driver-rebuild` may change it; no hand-edits or `cp` patches.
- One agent → one PR worktree; never two agents in the same tree.
- Before any live test: `readlink -f ~/coding/hapi-active` matches the intended worktree.
- Every worktree: `hub/.env` → `~/.hapi/hub.env`.
- Frontend changes: `bun run build` in that worktree's `web/` before `hapi-use-worktree`.
- After testing: `hapi-use-driver` (legacy alias: `hapi-use-main`) unless operator wants the feature left live.

See [worktree-testing.md](./worktree-testing.md).

### 2. PR and review hygiene

Enforce for **all** agents (IDE, Claude Code, Cursor CLI/HAPI):

1. `/verification-before-completion` before any success claim or PR.
2. `/requesting-code-review` cold diff before `gh pr create` **and before every push** to a branch with an open PR (full `origin/<base>...HEAD`; see [cold-pr-review-rubric.md](./cold-pr-review-rubric.md)).
3. After push to an open PR: unresolved thread poll (hook or manual).
4. Reply + **resolve** every addressed review thread.

**Enforcement stack (weakest → strongest):**

| Mechanism | Works in Cursor CLI/HAPI? |
|-----------|---------------------------|
| `~/coding/AGENTS.local.md` rules | Yes (if agent reads them) |
| `~/.local/bin/git` wrapper on `git push origin` (open PR) | Yes (stderr STOP reminder; non-blocking) |
| `~/.local/bin/gh` wrapper on `gh pr create` | Yes (stderr checklist) |
| Claude `PreToolUse` on `gh pr create` + `git push origin*` | Claude only |
| Claude `PostToolUse` post-push poll | Claude only |
| Cursor IDE `beforeShellExecution` / `postToolUse` | IDE yes; headless `agent` **often no** (probe 2026-05-26) |

When CLI hooks do not fire, meta bot runs manual fallback after push:

```bash
~/.local/bin/pr-post-push-check-core.sh "$(git branch --show-current)"
```

See [pr-review-loop.md](./pr-review-loop.md).

### 3. Session and runner health

Monitor hub-connected agents:

```bash
hapi-sessions-health.sh           # all sessions
hapi-sessions-health.sh --watch   # BBS panel, 15s refresh
hapi-sessions-health.sh jellybot  # filter by path/flavor/id
```

Meta bot triages `STUCK?`, `ZOMBIE`, and missing runner PIDs; escalates or kills stale processes per operator policy.

Script: `~/coding/server-setup/scripts/hapi/hapi-sessions-health.sh` (operator tooling; symlinked as `~/.local/bin/hapi-sessions-health.sh`). Used to live in this repo at `scripts/hapi-sessions-health.sh`; relocated 2026-05-31 so `git stash -u` operations on HAPI worktrees don't sweep it away.

### 4. Verification commands (HAPI default)

From the **active worktree** (not necessarily main):

```bash
bun typecheck          # repo root
bun run test           # cli + hub
cd web && bun run build   # before hub UI test
```

Meta bot does not merge or declare "done" without evidence from these (or the repo's documented subset for a given change).

### 5. Fork `main` sync (mandatory cadence)

```bash
hapi-sync-fork-main              # after upstream merges
hapi-sync-fork-main --check-only # before driver rebuild / intake (also enforced by hapi-driver-rebuild)
```

Push `origin main` after sync. Fork `main` must stay **upstream/main + fork-only docs** — see [driver-soup.md](./driver-soup.md).

### 6. Documentation maintenance (tooling docs)

When tooling behavior changes, meta bot updates **in the same change**:

- The relevant file under `docs/tooling/`
- Repo `AGENTS.local.md` (operator-local, never upstream)
- Machine scripts at `~/.local/bin/` if source-of-truth moved

Keep [pr-review-loop.md](./pr-review-loop.md) honest about IDE vs CLI hook support.

### 7. Worktree lifecycle

After merge:

```bash
hapi-use-main
git worktree remove ~/coding/hapi-<feature>   # or --force if needed
```

Meta bot periodically lists `git worktree list` and flags stale trees.

---

## Session-start checklist (meta bot)

```bash
readlink -f ~/coding/hapi-active
git worktree list
systemctl is-active hapi-hub.service
test -L ~/coding/hapi/hub/.env && test -L ~/coding/hapi-active/hub/.env
hapi-sessions-health.sh | head -40
```

Then read both tooling docs if anything changed since last session.

---

## Session-start checklist (feature agents)

1. Read [`docs/operator/AGENTS.md`](../operator/AGENTS.md) (fork canon). For new behavior, read [new-feature-intake.md](./new-feature-intake.md) (orchestrator handoff §0).
2. Read repo `AGENTS.local.md` (or `~/coding/AGENTS.local.md`).
3. Confirm `git branch --show-current` and `pwd` — worktree, not main checkout.
4. Skim [new-feature-intake.md](./new-feature-intake.md) for soup vs clean demo and §6 gates (tests, cold review, Playwright **before** operator browser test).
5. Skim [worktree-testing.md](./worktree-testing.md) if touching hub or systemd.
6. Skim [pr-review-loop.md](./pr-review-loop.md) before push/PR (after operator dogfood approval).

---

## Escalation to operator

Meta bot stops and asks when:

- `hapi-active` points at unknown path
- Hub won't start after swing (missing build, bad env, port conflict)
- Multiple agents in `STUCK?` on same repo
- Hook/machine drift (doc says X, system does Y)
- Upstream PR would include operator-local or secret files
