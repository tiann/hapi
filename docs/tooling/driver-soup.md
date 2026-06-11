# Daily Driver + Merge-Train Worktrees

> **AGENTS: read this first** (Cursor, Claude, Codex, Gemini, any other). Do NOT run `hapi-use-worktree`, `hapi-use-driver`, or `hapi-driver-rebuild --activate` to test your own feature branch. These swing the live stack and **kill your own session**. Soup-add your branch via `~/.config/hapi/driver-manifest.yaml` and run `hapi-driver-rebuild --build-web --verify` instead - that builds + tests without touching the live hub. The operator decides when to swing live. Multiple layers enforce this since 2026-06-11. The script refuses when called from inside the target worktree or with `HAPI_AGENT_CONTEXT=1`. `HAPI_STACK_SWITCH_YES=1` is for operator cron/CI, not agent tool-calls. `sudo systemctl <destructive> hapi-{hub,runner,runner-watchdog}.service` is blocked at three layers: (1) `/usr/local/sbin/systemctl` wrapper (agent-agnostic; catches all sudo invocations across all agents including `sudo bash -c '...'` shell-wraps), (2) sudoers `!`-rule at `/etc/sudoers.d/hapi-protect` (catches absolute-path bypass), (3) Cursor preToolUse hook (preempts at tool-call layer for cleanest UX). Use `hapi-restart-hub` or `hapi-use-worktree` instead - they do patient drain. See `.cursor/rules/operator-fork.mdc#sudo-systemctl-on-hapi-services` for the full coverage matrix.

Three git layers on this machine:

```
~/coding/hapi              primary repo checkout → upstream/main mirror (reference)
~/coding/hapi-main         symlink → ~/coding/hapi (when primary is on main)
~/coding/hapi-driver       driver/integration — bleeding-edge soup on :3006
~/coding/hapi-<name>       one worktree per upstream PR you are formulating
~/coding/hapi-garden       XR garden (API proxied to :3006 — rides the soup)
```

`hapi-active` → the **active HAPI tree**. Both `hapi-hub.service` and `hapi-runner.service` run from this symlink (same commit, same repo — hub + cli).

---

## Unified stack switch

HAPI is **one monorepo** (`hub/`, `cli/`, `web/`, `shared/`). A switch must move **hub and runner together** or you get split-brain (e.g. hub has `#684` Cursor models, npm runner does not).

| Service | Runs from |
|---------|-----------|
| `hapi-hub.service` | `$HOME/coding/hapi-active/hub` |
| `hapi-runner.service` | `$HOME/coding/hapi-active/cli` via `hapi-runner-from-active` |

```bash
hapi-use-worktree ~/coding/hapi-driver   # prompts, then restarts hub + runner
hapi-use-driver                          # same, daily driver path
```

**Always prompts** before restart (kills remote agent sessions). Non-interactive requires `HAPI_STACK_SWITCH_YES=1`.

After `hapi-driver-rebuild`, run `hapi-use-driver` when ready — rebuild alone does not restart services.

**Do not** run `hapi-watch-activate-driver` from inside a Cursor agent turn without `--exclude-agent-session` (ouroboros: this session stays WORKING until the agent exits). See [watch-activate-driver.md](./watch-activate-driver.md).

## Daily driver (soup)

**Manifest:** `~/.config/hapi/driver-manifest.yaml` (operator-local; example in repo)

```yaml
base: upstream/main
layers:
  - branch: feat/pluggable-voice-backend
  - pr: 692
  - branch: origin/feat/session-list-attention
```

Layers merge **in order** onto `driver/integration` inside `~/coding/hapi-driver`.

### Read-only driver tree

**`~/coding/hapi-driver` is read-only between rebuilds.** The only supported way to change it is:

```bash
# 1. Edit ~/.config/hapi/driver-manifest.yaml (add/remove layers)
# 2. Rebuild — resets to base + merges manifest (destroys local edits)
hapi-driver-rebuild --build-web [--verify]
# 3. When ready, swing live stack (prompts)
hapi-use-driver
```

**Forbidden on `hapi-driver`:** hand-edits, `cp` from other checkouts, local commits, `bun run build` as a substitute for rebuild. Uncommitted changes block rebuild (git stash) and are easy to lose.

**To put new code on `:3006` without editing the driver tree:** merge-train PR in a worktree, then `hapi-use-worktree ~/coding/hapi-<name>` (operator confirms).

### Rebuild (does not restart hub by default)

```bash
hapi-driver-rebuild                 # merge from manifest
hapi-driver-rebuild --build-web     # also build web/dist (atomic swap, agent-safe)
hapi-driver-rebuild --verify        # typecheck + test
hapi-driver-rebuild --activate      # calls hapi-use-worktree (hub + runner; prompts)
```

**Prefer** rebuild without `--activate`, then when ready:

```bash
hapi-use-driver   # restarts hapi-hub + hapi-runner together
```

### Atomic web swap (no 503 / blank-shell window)

`--build-web` is **agent-safe by default**. The hub serves web/dist from disk on :3006 — naive `vite build` empties dist before writing, leaving a multi-second window where any browser reload returns a blank shell and live agent sessions get nudged out-of-band.

The rebuild script instead:

1. builds into `web/dist.next/` (sibling, untouched while building)
2. sanity-checks `dist.next/index.html` exists
3. renames the current `web/dist/` → `web/dist.prev/` (atomic)
4. renames `web/dist.next/` → `web/dist/` (atomic)

The window where `web/dist/` is absent shrinks to the gap between two `rename(2)` calls — well below TCP retry granularity. Live sessions on :3006 are unaffected; nobody has to coordinate a refresh.

**Web-only fix to live `:3006` while sessions are working:**

```bash
hapi-driver-rebuild --build-web   # merge manifest + atomic swap; hub keeps running
# Hard-reload one browser to confirm the new bundle, then announce.
```

No `hapi-use-driver` needed unless `hub/` or `cli/` changed.

**Cheap rollback** if the new bundle is broken:

```bash
hapi-driver-rollback-web          # promotes web/dist.prev back to live
```

`dist.prev` only holds the **most recent** prior build (each rebuild rotates it). For deeper rollback, re-run `hapi-driver-rebuild` against an earlier manifest.

### When upstream moves

1. **Sync fork mirror:** `hapi-sync-fork-main` then `git push origin main`
2. Edit manifest — drop layers merged to `upstream/main`
3. `hapi-driver-rebuild --build-web --verify` (refuses if fork `main` is behind upstream)
4. `hapi-use-driver` when ready
5. Garden smoke: `curl -sf http://127.0.0.1:3006/health` + quick web/VR check
6. Log drift in `~/coding/hapi-garden/GARDEN_LOGBOOK.md` if API changed

### Keeping fork `main` truthful

Fork `main` = **`upstream/main` + fork-only docs/plans**. After upstream merges: run `hapi-sync-fork-main`. Meta bot: weekly `--check-only` even if idle.

---

## PR formulation worktrees (clean upstream PRs)

**Never** file upstream PRs from `hapi-driver`. Work in dedicated trees.

```bash
# Simple PR off upstream/main
hapi-worktree-create session-attention --branch feat/session-list-attention

# Merge train: your PR stacks on unmerged work
hapi-worktree-create voice-labels --branch fix/voice-flavor-labels \
  --after feat/pluggable-voice-backend

hapi-worktree-create stacked --branch feat/my-thing --after pr:692
```

Each creates `~/coding/hapi-<name>`, branch from `upstream/main` (or `--base`), optional `--after` merges.

Before every commit / `gh pr create`:

```bash
pwd
git branch --show-current
```

---

## Garden vs soup

Garden shared mode (`garden-web.service` → `:5174` → API `:3006`) always talks to **whatever hapi-active runs**.

- Soup changes hub routes/voice → may break garden until garden UI adapts
- Garden worktree (`hapi-garden`) is independent frontend; hub soup is the experiment surface
- Treat garden regressions as driver-manifest / API contract issues, not separate hub installs

---

## Scripts

| Command | Purpose |
|---------|---------|
| `hapi-driver-rebuild` | Rebuild soup from manifest (`--build-web` swaps atomically — agent-safe) |
| `hapi-driver-rollback-web` | Promote `web/dist.prev` back to live (no hub restart) |
| `hapi-worktree-create` | New PR worktree (+ merge train) |
| `hapi-use-worktree <path> [--impatient]` | **Patient by default** — drain WORKING sessions, swing `hapi-active`, prep DB, restart hub + runner |
| `hapi-use-driver` | Swing to daily driver soup (inherits patient default) |
| `hapi-restart-hub [--impatient] [--no-runner]` | **Patient hub bounce** — drain WORKING sessions, then `systemctl restart`. Use INSTEAD of raw `sudo systemctl restart hapi-hub.service` |
| `hapi-driver-db-prep <target>` | Backup DB + auto-downgrade schema to match `<target>`'s SCHEMA_VERSION; called automatically by `hapi-use-worktree` |
| `hapi-driver-status [--json\|--quiet\|--watch]` | Read coordination state — is a rebuild/switch in flight, when did the last one finish, how many WORKING sessions right now |
| `hapi-runner-from-active` | systemd helper — runner CLI from `hapi-active/cli` |
| `hapi-sessions-health.sh` | Session monitor |

Sources: `scripts/tooling/` in repo; installed to `~/.local/bin/`.

### Coordination (avoid stack-switch contention)

With ~30 agents on this repo, two callers can land on `hapi-driver-rebuild` or `hapi-use-worktree` simultaneously — one rewrites the driver tree mid-merge while the other reads it, or two stack switches race on the symlink and hub restart.

Both scripts now take a `flock` on `~/.hapi/locks/{rebuild,switch}.lock` and publish state to `~/.hapi/driver-status.json` (atomic rewrite, schema v1). A second concurrent invocation exits **75** (`EX_TEMPFAIL`) with a pointer at the first.

**Before kicking off a rebuild or switch** (especially from a peer agent), run:

```bash
hapi-driver-status            # human summary
hapi-driver-status --quiet    # exit 0 idle, 75 busy, 2 stale-pid
```

`--quiet` is the right thing for an agent precheck:

```bash
if ! hapi-driver-status --quiet; then
    echo "driver stack busy or stale -- inspect with hapi-driver-status"
    exit 1
fi
hapi-driver-rebuild --build-web --verify
```

**Stale state** (process died without releasing): `hapi-driver-status` prints `STALE pid=N (dead)` and the exact `rm` to clear the lock. The status file self-heals on the next successful run.

**Bypass** (testing only): `HAPI_SKIP_DRIVER_LOCK=1`. Skips both flock and status writes; collisions corrupt the driver tree.

**Why no hub API route?** The hub may be down *during* a switch — exactly when status is most wanted. File-backed status is readable when the hub is dead.

### Patient restarts (don't yank live agents)

`hapi-use-worktree` and `hapi-restart-hub` are **patient by default**: they poll `hapi-sessions-health.sh` for `WORKING` sessions and wait (default 30s poll, 10min timeout) before tearing the hub down. The timeout is a safety valve — a stuck agent that never finishes WORKING shouldn't deadlock the whole stack — but normal turns will complete and the restart proceeds cleanly.

**Never do this:**

```bash
sudo systemctl restart hapi-hub.service           # kills mid-turn agents
sudo systemctl restart hapi-hub.service hapi-runner.service
```

**Always do this:**

```bash
hapi-restart-hub              # bounce hub + runner, patient
hapi-restart-hub --no-runner  # bounce hub only
hapi-use-worktree <path>      # stack switch, patient
```

**Tuning:**

| Env / flag | Default | Effect |
|-----------|---------|--------|
| `--impatient` | off | Skip drain. Restart now. Use when the hub is hung. |
| `HAPI_IMPATIENT=1` | off | Same, via env. For non-interactive watchdogs. |
| `HAPI_PATIENT_TIMEOUT=<sec>` | 600 | Max drain wait before proceeding with WORKING>0. `0` = wait forever (deadlock risk). |
| `HAPI_PATIENT_INTERVAL=<sec>` | 30 | Poll cadence. |

If the timeout fires, both wrappers log which sessions were still WORKING before proceeding — that's the signal an operator wants to see, not a silent yank.

**Known gap:** the underlying `hapi-sessions-health.sh --json` returns `id: null, tag: null` for WORKING entries (only the count is right). The drain still works (it acts on count), and `hapi-driver-status` shows the count, but identifying *who* is still working requires a separate read against the hub. Filed as a follow-up.

---

### DB schema jiu-jitsu (auto-handled, 2026-06-01)

The hub's SQLite store has **forward step-migrations only** (v1 -> v2 -> ... -> N). When the manifest changes the effective SCHEMA_VERSION, the live DB at `~/.hapi/hapi.db` must match the target tree before hub boot:

- **Adding a schema-bumping layer (e.g. `feat/android-wear-companion` v9 -> v10):** automatic. Hub boots, `stepMigrations[N]` runs, DB ratchets forward. Nothing to do.
- **Removing one (rolling back to upstream/main; v10 -> v9):** the hub code has no down-migrations. `hapi-driver-db-prep.sh` auto-invokes from `hapi-use-worktree`, backs up the DB (timestamped `~/.hapi/hapi.db.bak.pre-activate-<UTC>`), and applies known reverse SQL.

**Known reverse transitions** (extend `apply_downgrade_step()` in `scripts/tooling/hapi-driver-db-prep.sh` when a new bump lands):

| Direction | Effect | Data loss |
|-----------|--------|-----------|
| v10 -> v9 | DROP TABLE `fcm_devices` + 2 indexes (introduced by `feat/android-wear-companion`) | FCM device registrations gone from live DB; preserved in backup; Android companion re-registers on next launch |

**Bypass** (not recommended): `HAPI_SKIP_DB_PREP=1 hapi-use-worktree ...`. This restores the old behavior (raw `systemctl restart`) and you eat the hub-crash-on-schema-mismatch if you're going backward.

---

## First-time setup

```bash
mkdir -p ~/.config/hapi
cp ~/coding/hapi/docs/tooling/driver-manifest.example.yaml ~/.config/hapi/driver-manifest.yaml
# edit layers

hapi-driver-rebuild --build-web --verify
hapi-use-driver   # prompts; restarts hub + runner together
```

Primary mirror:

```bash
cd ~/coding/hapi && git checkout main && git merge --ff-only upstream/main
ln -sfn ~/coding/hapi ~/coding/hapi-main
```

Move an existing feature branch off primary into its own worktree before switching primary to `main`:

```bash
hapi-worktree-create pluggable-voice --branch feat/pluggable-voice-backend
cd ~/coding/hapi && git checkout main
```
