# `~/coding/hapi*` reorganization plan

Status: **All phases DONE 2026-06-05.** Phase 1 (Option B) 2026-06-01; Phase 2 (drain) executed opportunistically 2026-06-04 through 2026-06-05 across two cleanup passes (android-agent triage + operator cleanup session); Phase 3 (Option C) executed 2026-06-05 in an impatient hub-down window (~1 min downtime, single active session 24f3ec91 was cut). All worktrees now live under canonical `~/coding/hapi/{driver,upstream,active,worktrees/*}`. `hapi-main` symlink removed (hard-cut). Only legitimate independents remain at top-level: `hapi-companion` (separate Android product repo), `hapi-monitor` (npm-installed tool), plus the residual nested-weird worktree `hapi-worktrees/voice-selection-all-backends-worktrees/0531-4033` flagged for operator triage.

Author note: this is a multi-agent repo. ~31 active agents have CWDs that may be inside dirs this plan moves. Coordination is the dominant cost, not the file moves.

## Operator decisions (2026-06-01)

| Question | Answer |
|----------|--------|
| Phase 1 today, low-risk Option B? | **Yes** - executed this session |
| Rename `~/coding/hapi-companion/`? | **No** - stays as-is, it's the independent Android companion product repo |
| Keep backward-compat symlinks (`~/coding/hapi-driver` -> `~/coding/hapi/driver`) after Phase 3? | **No** - hard-cut. Switch happens once, agents adapt. |
| Communication channel for the 31 agents about the new convention? | Per-directory awareness: when a worktree gets removed or moved, message the session in it before action. Bulk announcement not needed because the Cursor rule + audit warning catch new drift. |
| Can we PREVENT wrong-place worktree creation? | **Yes** - via PATH-precedence wrapper at `~/.local/bin/git` that intercepts `git worktree add` inside the hapi clone and refuses non-canonical targets (source tracked at `scripts/tooling/git-shim-worktree-guard.sh`). Wrapper passes through everything else; ~2.4ms overhead per git call. Bypass with `HAPI_SKIP_WORKTREE_GUARD=1`. Original answer ("git won't let us alias built-in subcommands") was lazy - the right answer is to wrap `git` itself at the PATH layer, not alias the subcommand. Carrot (`hapi-worktree-create`) and audit (`check-worktree-layout.sh` in pre-push) remain as additional layers. |

---

## 1. Current state (what's actually there)

### 1.1 At `~/coding/` root - the mess

```text
hapi/                                  real fork mirror, branch=main           (Cursor proj: home-heavygee-coding-hapi, 19 transcripts)
hapi-active             -> hapi-driver  symlink (used by all systemd)
hapi-main               -> hapi         symlink (backward-compat shortcut)
hapi-companion/                        INDEPENDENT REPO (heavygee/hapi-companion.git, not a worktree)

hapi-driver/                           worktree of hapi  [driver/integration] - the active soup
hapi-upstream/                         worktree of hapi  [upstream-main-test] - the upstream baseline we just built
hapi-garden/                           worktree of hapi  [garden/r3f-poc]
hapi-interior-life/                    worktree of hapi  [feat/hub-interior-life-notes]

hapi-cursor-resume-fix/                worktree of hapi  [fix/cursor-resume-id-early-persist]
hapi-cursor-summarize/                 worktree of hapi  [feat/cursor-summarize-738]
hapi-mermaid-lightbox-737/             worktree of hapi  [feat/mermaid-lightbox-737]
hapi-pwa-push-actions/                 worktree of hapi  [feat/pwa-notification-actions]
hapi-queued-sse-fix/                   worktree of hapi  [fix/global-sse-messages-consumed]
hapi-runner-handoff/                   worktree of hapi  [fix/runner-handoff-systemd-resilience]
hapi-session-attention/                worktree of hapi  [feat/session-list-attention]
hapi-voice-advanced-controls/          worktree of hapi  [feat/voice-advanced-controls]

hapi-worktrees/                        a partial-convention bucket (not all worktrees ended up in here)
  issue708/                            worktree of hapi  [fix/web-scroll-guard-unwrap-race]
  issue-709/                           worktree of hapi  [fix/hub-persist-permission-mode-709]
  issue-732-phase1-import-spawn/       worktree of hapi  [feat/issue-732-phase1-import-spawn]
  issue-resume-race-fix/               worktree of hapi  [fix/hub-resume-config-race-728]
  pluggable-voice/                     worktree of hapi  [feat/pluggable-voice-backend]
  pre-707-scroll/                      worktree of hapi  (detached)
  styling-issue/                       worktree of hapi  [hapi-styling-issue]
  upstream-main-ab/                    worktree of hapi  (detached, has dirty bun.lock)
  voice-selection-all-backends/        worktree of hapi  [feat/voice-selection-all-backends]
  voice-selection-all-backends-worktrees/
    0531-4033/                         worktree of hapi  [feat/voice-selection-all-backends]   (DOUBLY-NESTED, agent-spawned)
```

**Counts:** 1 main mirror + 12 top-level peer worktrees + 10 nested worktrees + 1 doubly-nested worktree + 1 independent repo + 2 symlinks = **27 directories** under `~/coding/hapi*`.

### 1.2 Path dependencies (anything that hard-codes `~/coding/hapi-*`)

**systemd units** (require `sudo` + `daemon-reload` + service restart to change):
- `/etc/systemd/system/hapi-hub.service` -> `WorkingDirectory=/home/heavygee/coding/hapi-active/hub`
- `/etc/systemd/system/hapi-runner.service` -> calls `/home/heavygee/.local/bin/hapi-runner-from-active`
- `/etc/systemd/system/hapi-runner-watchdog.service` -> `/home/heavygee/coding/hapi-active/cli/systemd/hapi-runner-watchdog.sh`
- `/etc/systemd/system/garden-web.service` -> `WorkingDirectory=/home/heavygee/coding/hapi-garden`

**`~/.local/bin/` tools** with `~/coding/hapi*` literals:
- `hapi-runner-from-active` (reads `HAPI_ACTIVE_LINK`, default `$HOME/coding/hapi-active`)
- `hapi-use-driver` (`HAPI_DRIVER`, default `$HOME/coding/hapi-driver`)
- `hapi-use-main` (same default)
- `hapi-use-worktree` (`HAPI_ACTIVE_LINK`, `HAPI_DRIVER`)
- `hapi-worktree-create` (`HAPI_PRIMARY=$HOME/coding/hapi`, creates new at `$HOME/coding/hapi-${NAME}` - this is the script that **caused** the top-level sprawl)
- `hapi-driver-rebuild`
- `hapi-watch-activate-driver`

**`~/.config/hapi/driver-manifest.yaml`** - references branches not paths, no change needed.

**State dirs (not in scope):** `~/.hapi/`, `~/.hapi-upstream/` - data live elsewhere, no path coupling.

**Cursor agent project keys** (path -> hash):
- `home-heavygee-coding-hapi` (19 transcripts) - the root mirror
- `home-heavygee-coding-hapi-queued-sse-fix`, `-runner-handoff`, `-worktrees-issue708`, `-worktrees-issue-709`, `-worktrees-issue-resume-race-fix`, `-worktrees-voice-selection--a1de796`, `-worktrees-voice-selection-all-backends-worktrees-0531-4033`, `-worktrees-gemini-investigation` (~9 known)
- **Changing any of these CWDs renames the Cursor project.** Existing transcripts stay where they are. Future resumes go to the new project ID.

---

## 2. Constraints driving the plan

| Constraint | Impact |
|------------|--------|
| ~31 active agents, many with CWD inside `~/coding/hapi-*` | Moving any peer dir kills the agent in it. Must coordinate stop -> move -> restart. |
| `~/coding/hapi/` IS the canonical fork mirror checkout | Cannot become a pure parent dir without moving `.git`. Moving `.git` invalidates every worktree's anchor pointer. |
| systemd hub + runner serve THIS chat session right now | Their `hapi-active` symlink target change is online. Their `WorkingDirectory` change requires sudo + daemon-reload + restart -> chat blackout window. |
| Cursor project key = path hash | Renaming dir = new Cursor project = lost resume continuity for agents in that dir. Root `~/coding/hapi/` agents are safe ONLY IF we leave that path untouched. |
| `git worktree move` rewrites both ends | But fails if the worktree is currently locked, dirty in incompatible ways, or has running processes (npm dev servers, etc) |
| `hapi-worktree-create` script is the root cause of new top-level dirs | If we don't change it, the next agent re-creates the mess in a day |

---

## 3. Target end-state (operator's request, refined)

```text
~/coding/hapi/                         the fork mirror checkout (branch=main) - UNCHANGED LOCATION
  .git/                                shared git dir for all worktrees
  .gitignore                           gains: /active, /driver, /upstream, /worktrees, /companion (where applicable)
  hub/  cli/  web/  shared/  docs/     existing source tree
  
  active            -> driver          symlink (was ~/coding/hapi-active -> ~/coding/hapi-driver)
  driver/                              worktree [driver/integration] (was ~/coding/hapi-driver)
  upstream/                            worktree [upstream-main-test or upstream/main] (was ~/coding/hapi-upstream)
  worktrees/                           bucket for everything else (was ~/coding/hapi-worktrees + scattered top-level)
    garden/                            worktree [garden/r3f-poc]                       (was ~/coding/hapi-garden)
    interior-life/                     worktree                                        (was ~/coding/hapi-interior-life)
    cursor-resume-fix/                 worktree                                        (was ~/coding/hapi-cursor-resume-fix)
    cursor-summarize/                  worktree                                        (was ~/coding/hapi-cursor-summarize)
    mermaid-lightbox-737/              worktree                                        (was ~/coding/hapi-mermaid-lightbox-737)
    pwa-push-actions/                  worktree                                        (was ~/coding/hapi-pwa-push-actions)
    queued-sse-fix/                    worktree                                        (was ~/coding/hapi-queued-sse-fix)
    runner-handoff/                    worktree                                        (was ~/coding/hapi-runner-handoff)
    session-attention/                 worktree                                        (was ~/coding/hapi-session-attention)
    voice-advanced-controls/           worktree                                        (was ~/coding/hapi-voice-advanced-controls)
    issue708/  issue-709/  ...         existing nested worktrees stay where they are
    pluggable-voice/                   etc

~/coding/hapi-companion/               STAYS where it is (independent product repo, not a worktree of hapi)
```

`~/coding/hapi-*` siblings disappear entirely once migration completes. `~/coding/hapi-main` symlink can be deleted (redundant since `~/coding/hapi` IS main).

---

## 4. Three options to get there

### Option A: Symlink overlay only (cosmetic, zero agent coordination)

**Move:** nothing. **Add:**

```bash
ln -s ../hapi-driver           ~/coding/hapi/driver
ln -s ../hapi-upstream         ~/coding/hapi/upstream
ln -s ../hapi-worktrees        ~/coding/hapi/worktrees
ln -s ../hapi-active           ~/coding/hapi/active
# (12 more for each top-level worktree, OR consolidate top-level ones manually first)
```

Then update docs + tooling to PREFER `~/coding/hapi/<sub>` paths going forward. Existing tools, systemd, agents keep working off old paths. New agents/scripts use new paths.

**Pros:**
- Zero downtime, zero agent disruption
- Reversible: `rm` the symlinks
- Can do today during this session

**Cons:**
- Underlying filesystem stays messy
- Adds a second naming convention layered on top of the old one (worse, not better, until cleanup)
- `git status` in `~/coding/hapi/` will show the new symlinks as untracked (gitignore them)
- The `hapi-worktree-create` script still creates at `~/coding/hapi-${NAME}` and we have to update it anyway

**Verdict:** **Not recommended** as the end-state. Useful as a transitional Phase 0 while doing B or C.

### Option B: Hybrid - move only NEW work to hapi/worktrees, leave running peers alone

**Move:** nothing existing. **Change:**

1. Update `hapi-worktree-create` to default to `${HAPI_PRIMARY}/worktrees/${NAME}` instead of `${HAPI_PRIMARY}/../hapi-${NAME}`.
2. Update `hapi-worktree-create` to also accept an `--at top` flag for the rare case someone wants the old layout.
3. Add `.gitignore` entries in `~/coding/hapi/` for `/worktrees/`, `/active`, `/driver`, `/upstream`, `/companion`.
4. Pre-create `~/coding/hapi/worktrees/` (empty dir) so the new default path exists.
5. Document the new convention in `docs/operator/AGENTS.md` so future agents pick it up.
6. Existing 22 worktrees stay where they are. Over time as they merge & get cleaned up, the sprawl naturally drains.

**Pros:**
- Zero downtime, zero agent disruption now
- Stops the bleeding (new worktrees no longer pollute `~/coding/`)
- Existing worktrees migrate on their own merge/cleanup cycle
- Tooling and docs converge on one convention

**Cons:**
- Mixed layout persists for weeks until peer worktrees merge out
- `hapi-active` and `hapi-driver` stay at top level (because moving them = systemd outage)
- Cleanup never "finishes" without a deliberate sweep

**Verdict:** **Recommended as the realistic first move.** Low cost, high payoff, no coordination.

### Option C: Full physical reorganization (the real cleanup)

**Move:** everything. Requires a maintenance window.

**Sequence:**

1. **Communicate ahead** - announce in operator chat / HAPI session messages: "All hapi peer agents must pause work and commit/push their state by HH:MM. Hub + runner will be offline for ~15 minutes during reorg."
2. **Snapshot baseline** - `git -C ~/coding/hapi worktree list > /tmp/hapi-worktrees-pre-reorg.txt`
3. **Stop services** - `sudo systemctl stop hapi-hub hapi-runner garden-web`
4. **Kill all peer agents** - whatever orchestrator owns them. Identify by `pgrep -af 'coding/hapi-'`. Each agent's terminal CWD becomes invalid after the move.
5. **Move worktrees with git** (preserves the worktree -> .git linkage):
   ```bash
   git -C ~/coding/hapi worktree move /home/heavygee/coding/hapi-driver           /home/heavygee/coding/hapi/driver
   git -C ~/coding/hapi worktree move /home/heavygee/coding/hapi-upstream         /home/heavygee/coding/hapi/upstream
   git -C ~/coding/hapi worktree move /home/heavygee/coding/hapi-garden           /home/heavygee/coding/hapi/worktrees/garden
   # ... ~22 more moves, all explicit
   git -C ~/coding/hapi worktree move /home/heavygee/coding/hapi-worktrees/issue708 /home/heavygee/coding/hapi/worktrees/issue708
   # etc - flattening hapi-worktrees/* up one level into hapi/worktrees/*
   # (or keep them, but then there's an intermediate hapi-worktrees that needs to go away too)
   ```
6. **Rebuild active symlink** - `rm ~/coding/hapi-active; ln -s ../hapi/driver ~/coding/hapi/active`
7. **Update systemd unit paths** in-place (4 units), `daemon-reload`, restart:
   - `hapi-hub.service`: `WorkingDirectory=/home/heavygee/coding/hapi/active/hub` (or `/home/heavygee/coding/hapi/driver/hub` directly)
   - `hapi-runner-watchdog.service`: `ExecStart=/home/heavygee/coding/hapi/active/cli/systemd/hapi-runner-watchdog.sh`
   - `garden-web.service`: `WorkingDirectory=/home/heavygee/coding/hapi/worktrees/garden`
8. **Update `~/.local/bin/` scripts** - rewrite `HAPI_PRIMARY`, `HAPI_DRIVER`, `HAPI_ACTIVE_LINK` defaults; `hapi-worktree-create` default location.
9. **Update workspace rules** - `~/coding/hapi/.cursor/rules/operator-fork.mdc`, `AGENTS.md`, `docs/operator/AGENTS.md` to document the new layout.
10. **Restart services** - `sudo systemctl start hapi-hub hapi-runner garden-web`
11. **Verify** - `git -C ~/coding/hapi worktree list` matches expectation; `/health` on hub responds; runner re-registers.
12. **Resume agent work** - operator restarts peer agents with their new CWDs.

**Pros:**
- Genuinely clean end-state
- Future tooling/docs have one canonical path
- Eliminates the doubly-nested-worktrees absurdity

**Cons:**
- ~15-30 min hub/runner downtime
- ALL 31 peer agents must pause and resume (each loses Cursor resume continuity unless we leave the SOURCE worktree path's transcripts in place AND new agents get spawned)
- High-touch: ~22 `git worktree move` operations, 4 systemd edits, 5+ script edits
- If any worktree has running dev servers / npm processes when moved, `git worktree move` fails -> partial state
- Cursor project IDs change for every moved worktree -> new transcript dirs, old transcripts orphaned (they stay at the old hash-keyed dir, just no longer get appended to)

**Verdict:** **Right end-state, wrong week.** Worth doing once 31 agents -> ~5 agents, or batched with another planned downtime (e.g. a major upstream merge).

---

## 5. Recommended path

**Phase 1 (DONE 2026-06-01):** Option B + drift guards
- [x] Updated `hapi-worktree-create` default to `~/coding/hapi/worktrees/${NAME}` (with deprecated `--at top` fallback)
- [x] Created `~/coding/hapi/worktrees/` empty dir + `.gitkeep`
- [x] Added `.gitignore` entries in `~/coding/hapi/.gitignore`: `/active`, `/driver`, `/upstream`, `/worktrees/*` (negated `!/worktrees/.gitkeep`)
- [x] Created `.cursor/rules/worktree-layout.mdc` (alwaysApply rule) so future agents pick new convention by default
- [x] Created `scripts/tooling/check-worktree-layout.sh` (mirrors `check-stash-advisory.sh` pattern)
- [x] Wired audit into `scripts/tooling/git-hooks/pre-push` (advisory, non-blocking, `HAPI_SKIP_WORKTREE_AUDIT=1` to bypass)
- [x] Created `scripts/tooling/git-shim-worktree-guard.sh` and patched `~/.local/bin/git` wrapper to call it before `git worktree add`. Hard block on non-canonical paths inside the hapi clone (bypass: `HAPI_SKIP_WORKTREE_GUARD=1`). 13 unit + 4 E2E tests pass. Non-hapi repos unaffected. ~2.4ms overhead per git invocation.
- [x] Documented new convention in `docs/operator/AGENTS.md`
- Awareness for already-running agents: handled per-directory when their worktree gets drained in Phase 2 (no bulk broadcast needed - audit + rule catch new drift)

**Phase 2 (opportunistic, over the next 1-2 weeks):** drain
- Each worktree that finishes its branch's lifecycle (merged or abandoned): `git worktree remove`. Don't recreate at old path.
- Naturally consolidates without coordinated action.

**Phase 3 (one-shot maintenance window, when agent count is low):** Option C
- Physically move the few remaining stragglers + `hapi-driver`, `hapi-upstream`, `hapi-active`
- Update systemd + scripts
- ~10-15 min hub downtime
- Done.

---

## 6. Open questions for operator before any execution

ALL ANSWERED 2026-06-01 - see "Operator decisions" at top of file. Summary:

1. `~/coding/hapi-companion/` stays - independent repo, prefix is brand-link.
2. Phase 1 (Option B) executed this session.
3. No backward-compat symlinks after Phase 3 - hard-cut.
4. No bulk agent broadcast - per-directory awareness as each worktree drains.

---

## 7. Risks I'm watching even for Option B

- `hapi-worktree-create` change: needs careful test that existing `HAPI_PRIMARY` override still works for someone who's customized it.
- `.gitignore` for `worktrees/` etc - if any of those subdirs ever contain something we DO want tracked (a top-level README or symlinks list), we need explicit negation patterns. Currently nothing planned to live there as tracked files.
- The fact that `~/coding/hapi-worktrees/voice-selection-all-backends-worktrees/0531-4033` is **doubly nested** is itself a bug - some agent already misuses worktree creation. Worth a separate audit of that.

---

## 8. What I am NOT planning to do without explicit go

- Touch `~/coding/hapi-companion/` (independent product)
- Move `~/coding/hapi-driver/` while hub serves this session
- Stop / restart hub or runner systemd
- Send messages to other agents
- Delete any `hapi-*` directory anywhere
