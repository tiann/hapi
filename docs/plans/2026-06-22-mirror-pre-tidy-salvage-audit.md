# Salvage audit — `mirror/pre-tidy-20260622`

**Date:** 2026-06-22  
**Backup tip:** `acac8209` (41 non-merge commits ahead of reset `main`)  
**Process:** [`docs/tooling/salvage-closure.md`](../tooling/salvage-closure.md)

---

## Summary

Mirror `main` was reset to `origin/main` after PRs #58 (lifecycle SSOT) and #59 (fork path policy). The backup preserves everything that had accumulated locally and never pushed cleanly.

**Orchestrator verdict (2026-06-22):** All six clusters have a disposition. **Do not merge the backup.** Upstream product gap is **`main` is 25 commits behind `upstream/main`** — fix with normal sync, not backup cherry-picks. Fork tooling on the backup lives on **`origin/feat/hapi-peer-stack`**. Peer sign-off briefings are linked per cluster; operator should paste those to resume sessions before deleting the backup branch.

---

## Cluster index

- **A — upstream product (25 commits)** — `REDUNDANT` (pending upstream sync)
- **B — lifecycle / workflow docs (6 commits)** — `REDUNDANT` (PR #58)
- **C — fork path policy (2 commits)** — `REDUNDANT` (PR #59)
- **D — soup rebuild clarification (2 commits)** — `REDUNDANT` (lifecycle SSOT)
- **E — peer-stack + fork tooling bundle (8 commits)** — `MIGRATED` → `feat/hapi-peer-stack`
- **F — pre-tidy orchestration** — `REDUNDANT` (tidy complete; this audit + `salvage-closure.md`)

---

## A — Upstream product

**Commits (sample):** `e23ae1b2` Pi #862, `2643f178` share target #933, `4bc33939` display_image #944, `2ab3b398` hub-restart #923, … (25 total, all on `upstream/main`)

**Root cause (orchestrator):** Fork mirror `main` was used as an integration branch — `merge(upstream)` landed locally (`f3d0c90a` @ `02a0aa67`) but never pushed to `origin/main` before the tidy reset.

**Current truth:** Same commits are on `upstream/main`. Mirror `main` @ `22324dbb` is **25 commits behind** upstream.

**Proof:**

```bash
git fetch upstream
git rev-list --count main..upstream/main   # expect 25
git merge-base --is-ancestor e23ae1b2 upstream/main && echo OK
```

**Disposition:** `REDUNDANT` — recover via `hapi-sync-fork-main` or merge `upstream/main`, not from backup.

**Responsible peers:** Various upstream PR authors; no single session. No peer spawn required unless sync fails.

**Prevention:** Never merge upstream into mirror `main` without immediate push or a dedicated `sync/*` branch.

---

## B — Lifecycle / workflow docs

**Commits:** `3a9b3a94`, `26a15e9f`, `b965e604`, `fd1dfb42`, `7c6c1eb1`, `0afe1660`

**Root cause:** Doc work committed on mirror `main` in parallel with PR branch `docs/feature-work-lifecycle`; squash merge on GitHub (#58) became canonical.

**Current truth:** `origin/main` @ `b9bf4648` — [`feature-work-lifecycle.md`](../tooling/feature-work-lifecycle.md)

**Proof:**

```bash
git log -1 --oneline origin/main -- docs/tooling/feature-work-lifecycle.md
# b9bf4648 docs: single source of truth for local dev workflow (#58)
```

**Disposition:** `REDUNDANT`

**Responsible session:** `6904d349-f576-489f-bcd7-972f37f3942a` (orchestrator tidy + SSOT alignment)

**Peer opinion (orchestrator, same session):** Backup doc commits are stale duplicates of #58. Safe to discard; do not cherry-pick.

---

## C — Fork path policy

**Commits:** `cde8b105`, `ac7ec0f0`

**Root cause:** Policy landed on mirror `main` and on branch `tooling/fork-path-policy`; GitHub got squash #59 first.

**Current truth:** `origin/main` @ `490c8bfb` — [`commit-hooks.md`](../tooling/commit-hooks.md), `scripts/tooling/lib/fork-path-policy.sh`

**Disposition:** `REDUNDANT`

**Responsible session:** `6904d349-f576-489f-bcd7-972f37f3942a`

---

## D — Soup rebuild clarification

**Commits:** `2dfc71ec`, `7c6c1eb1` (overlap with B)

**Current truth:** Absorbed into lifecycle SSOT soup dogfood tree — agent-safe rebuild vs operator stack swing.

**Disposition:** `REDUNDANT`

---

## E — Peer-stack + fork tooling bundle

**Commits:**

- `0ddfa1ee` — `hapi-peer-stack.sh` + registry
- `253553a3`, `2202e9f0`, `b989b64b`, `d1166acf` — PR emoji sweep + `hapi-pr-status`
- `d52e5994` — `hapi-remote-agent-budget.sh`
- `9c534898` — overseer v11→v10 downgrade helper
- Plus tooling helpers: `hapi-display-image.mjs`, `hapi-driver-db-prep.sh`, `lib/peer-stack-*.sh`

**Root cause (orchestrator):** Peer-stack implementation and adjacent fork tooling were committed to **mirror `main`** instead of only `feat/hapi-peer-stack` / `tooling/*` branches — classic integration-on-primary mistake.

**Current truth:** All of the above are on **`origin/feat/hapi-peer-stack`** (not on `main`). Plan: [`2026-06-20-hapi-peer-stack-default.md`](./2026-06-20-hapi-peer-stack-default.md).

**Proof:**

```bash
git merge-base --is-ancestor 0ddfa1ee origin/feat/hapi-peer-stack && echo peer-stack OK
git diff mirror/pre-tidy-20260622 origin/feat/hapi-peer-stack -- scripts/tooling/hapi-peer-stack.sh
# (empty or only post-merge main resolution)
test ! -f scripts/tooling/hapi-peer-stack.sh && echo "not on mirror disk — use branch"
```

**Disposition:** `MIGRATED` — backup tooling slice discardable; canonical home is `feat/hapi-peer-stack` until merged via PR.

**Responsible peer:** Feature peer for peer-stack (spawn from plan § "Dedicated agent handoff"). Transcript not indexed under `hapi-peer-stack` string — use plan + branch.

**Spawn briefing:** [`peer-briefings/2026-06-22-salvage-closure-peer-stack-tooling.md`](./peer-briefings/2026-06-22-salvage-closure-peer-stack-tooling.md)

**Peer sign-off (2026-06-22):** Session peer-stack salvage review — **`MIGRATED`**. Backup tooling slice byte-identical to `origin/feat/hapi-peer-stack` on all nine paths; no cherry-pick from backup needed for peer-stack core. Split recommendation: merge `peer-stack*` only in peer-stack PR; emoji/budget/DB-prep are orthogonal (see emoji closure briefing).

**Emoji sub-slice:** Meta PR watcher closure — backup **`MIGRATED`**; fork `main` had **`SALVAGE` gap** (docs reference scripts missing on `main`). Action: branch `tooling/pr-emoji-sweep` with commits `d1166acf`, `b989b64b`, `253553a3`, `2202e9f0`.

---

## F — Pre-tidy orchestration

**Action:** Reset `main` to `origin/main`, created `mirror/pre-tidy-20260622`, restored tooling WIP patch, pushed `mirror-main-layout.md`.

**Disposition:** `REDUNDANT` — process complete; this audit closes the loop.

---

## Delete backup branch (operator gate)

Run only when:

- [ ] Cluster A: `git rev-list --count main..upstream/main` is 0 (or accepted fork delta documented)
- [ ] Clusters B–D: no open questions
- [ ] Cluster E: peer-stack peer signed `MIGRATED` or `SALVAGE` with cherry-picks done
- [ ] This audit file committed locally (`HAPI_ALLOW_OPERATOR_COMMIT=1`)

```bash
git branch -d mirror/pre-tidy-20260622
```

---

## Next actions

1. **`hapi-sync-fork-main`** — close cluster A (25 upstream commits).
2. **Resume peer-stack peer** with [`2026-06-22-salvage-closure-peer-stack-tooling.md`](./peer-briefings/2026-06-22-salvage-closure-peer-stack-tooling.md).
3. **Optional:** PR `feat/hapi-peer-stack` → `main` or keep fork-only until upstream extraction phase.
