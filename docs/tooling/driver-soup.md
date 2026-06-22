# Daily Driver + Merge-Train Worktrees

> **Workflow (mermaid, done criteria, agent permissions):** [`feature-work-lifecycle.md`](./feature-work-lifecycle.md) **only.** This file is manifest mechanics, DB jiu-jitsu, locks, and atomic swap — not a second copy of the flow.

Three git layers on this machine:

```
~/coding/hapi              primary mirror (fork main + tooling docs)
~/coding/hapi/driver       driver/integration — daily soup tree on :3006
~/coding/hapi/worktrees/<name>   one worktree per feature / upstream PR
~/coding/hapi/worktrees/garden-route   XR Garden source (manifest layer)
```

Legacy paths (`~/coding/hapi-driver`, `~/coding/hapi-<name>`) may still exist — **new work** uses `~/coding/hapi/worktrees/<name>` only.

`hapi-active` → the **active HAPI tree**. Hub + runner systemd units run from this path (`hub/` + `cli/`).

---

## Daily driver (soup)

**Manifest:** `~/.config/hapi/driver-manifest.yaml` (operator-local; example in repo)

```yaml
base: upstream/main
layers:
  - branch: feat/pluggable-voice-backend
  - pr: 692
  - branch: origin/feat/session-list-attention
```

Layers merge **in order** onto `driver/integration` inside `~/coding/hapi/driver`.

### Read-only driver tree

**`~/coding/hapi/driver` is read-only between rebuilds.** The only supported way to change it is:

```bash
# 1. Edit ~/.config/hapi/driver-manifest.yaml (add/remove layers)
# 2. Rebuild — resets to base + merges manifest (destroys local edits)
hapi-driver-status --quiet
hapi-driver-rebuild --build-web [--verify]
# 3. Dogfood on :3006 — follow feature-work-lifecycle.md § Soup dogfood decision tree
```

**Forbidden on `driver/`:** hand-edits, `cp` from other checkouts, local commits, raw `bun run build` in `web/` for production dogfood.

**Operator scripts** (`scripts/tooling/hapi-pr-session-emoji.sh`, `hapi-pr-emoji-batch.sh`, etc.) belong on **fork `main` in `~/coding/hapi`**, not in the driver tree. Rebuild reads tooling from the primary mirror (`HAPI_PRIMARY`, default `~/coding/hapi`). Uncommitted scripts vanish on sync/reset — **commit them to fork main**.

**To put a PR worktree on `:3006` instead of soup:** operator runs `hapi-use-worktree ~/coding/hapi/worktrees/<name>` (not the usual daily-driver path).

### Rebuild (does not restart hub by default)

```bash
hapi-driver-rebuild                 # merge from manifest
hapi-driver-rebuild --build-web     # also atomic web/dist swap + verify guard
hapi-driver-rebuild --verify        # typecheck + test + promotion stamp
hapi-driver-build-web               # web/dist only — no manifest re-merge
hapi-driver-rebuild --activate      # FORBIDDEN for agents — calls hapi-use-worktree
```

**Compile pre-flight (2026-06-19):** every rebuild, stack switch, and `hapi-restart-hub` runs conflict-marker scan + hub store parse before touching live services.

### Soup dogfood

**Do not duplicate the chart here.** Follow [`feature-work-lifecycle.md` § Soup dogfood decision tree](./feature-work-lifecycle.md#soup-dogfood-decision-tree-production-3006) end-to-end.

### Atomic web swap (no 503 / blank-shell window)

`--build-web` is **agent-safe by default**. The hub serves web/dist from disk on :3006 — naive `vite build` empties dist before writing, leaving a multi-second window where any browser reload returns a blank shell and live agent sessions get nudged out-of-band.

The rebuild script instead:

1. builds into `web/dist.next/` (sibling, untouched while building)
2. sanity-checks `dist.next/index.html` exists
3. renames the current `web/dist/` → `web/dist.prev/` (atomic)
4. renames `web/dist.next/` → `web/dist/` (atomic)

The window where `web/dist/` is absent shrinks to the gap between two `rename(2)` calls — well below TCP retry granularity. Live sessions on :3006 are unaffected; nobody has to coordinate a refresh.

6. runs **`verify-soup-web-dist.mjs`** — auto-rollback to `dist.prev` on fail
7. **Memory preflight** — refuses vite when swap >85% (see [feature-work-lifecycle.md § Soup build](./feature-work-lifecycle.md#soup-build-system-vs-web))

**Web-only fix to live `:3006` while sessions are working:**

```bash
hapi-driver-build-web                 # or rebuild --build-web
hapi-verify-web-dist
# Then hard-reload — steps in feature-work-lifecycle.md
```

**Cheap rollback** if the new bundle is broken:

```bash
hapi-driver-rollback-web          # promotes web/dist.prev back to live
```

`dist.prev` only holds the **most recent** prior build (each rebuild rotates it). For deeper rollback, re-run `hapi-driver-rebuild` against an earlier manifest.

### When upstream moves

1. **Sync fork mirror:** `hapi-sync-fork-main` then `git push origin main`
2. Edit manifest — drop layers merged to `upstream/main`
3. `hapi-driver-rebuild --build-web --verify`
4. `hapi-restart-hub` when hub/cli changed; hard-reload when web changed
5. Garden smoke: `curl -sf http://127.0.0.1:3006/health` + quick web/VR check
6. Log drift in `~/coding/hapi-garden/GARDEN_LOGBOOK.md` if API changed

### Keeping fork `main` truthful

Fork `main` = **`upstream/main` + fork-only docs/plans**. After upstream merges: run `hapi-sync-fork-main`. Meta bot: weekly `--check-only` even if idle.

---

## PR formulation worktrees (clean upstream PRs)

**Never** file upstream PRs from `~/coding/hapi/driver`. Work in dedicated worktrees.

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

**As of 2026-06-16:** Garden is a **first-class manifest layer** in the daily driver web app, not a separate frontend.

- **Route:** `/garden` (lazy-loaded R3F/WebXR) in the same `web/dist` the hub serves on `:3006`
- **Manifest layer:** `feat/garden-route` (source worktree: `~/coding/hapi/worktrees/garden-route`)
- **Voice/API:** same hub as flat HAPI — `VoiceBackendSession`, shared `localStorage` prefs, operator manifest voice stack
- **Retired:** standalone `garden-web.service` / `:5174` fork (`~/coding/hapi/worktrees/garden`, branch `garden/r3f-poc`) — historical only

Soup changes to hub routes/voice still affect Garden. Rebuild with `hapi-driver-rebuild --build-web`; web-only changes swap atomically. Hub/cli changes need `hapi-restart-hub` after rebuild when already on driver soup.

Pre-push hook blocks `web/src/garden/**` on upstream-PR-bound refs — Garden is fork/daily-only until a plugin system or upstream home exists.

---

## Scripts

| Command | Purpose |
|---------|---------|
| `hapi-driver-rebuild` | Rebuild soup from manifest (`--build-web` + verify-web-dist guard) |
| `hapi-driver-build-web` | Web/dist only on current driver tree (no re-merge) |
| `hapi-verify-web-dist` | Audit: driver `web/src` strings present in live `web/dist` |
| `hapi-driver-rollback-web` | Promote `web/dist.prev` back to live |
| `hapi-worktree-create` | New PR worktree (+ merge train) |
| `hapi-use-worktree <path> [--impatient]` | **Patient by default** — drain WORKING sessions, swing `hapi-active`, prep DB, restart hub + runner |
| `hapi-use-driver` | **Operator:** swing `hapi-active` to driver + restart (verify stamp) |
| `hapi-restart-hub [--impatient] [--no-runner]` | **Agent OK:** patient restart hub (+ runner) on current stack — no symlink move |
| `hapi-driver-db-prep <target>` | Backup DB + auto-downgrade schema to match `<target>`'s SCHEMA_VERSION; called automatically by `hapi-use-worktree` |
| `hapi-driver-status [--json\|--quiet\|--watch]` | Read coordination state — is a rebuild/switch in flight, when did the last one finish, how many WORKING sessions right now |
| `hapi-runner-from-active` | systemd helper — runner CLI from `hapi-active/cli` |
| `hapi-sessions-health.sh` | Session monitor |

Sources: `scripts/tooling/` in repo; installed to `~/.local/bin/`.

### Coordination (avoid stack-switch contention)

With ~30 agents on this repo, two callers can land on `hapi-driver-rebuild` or `hapi-use-worktree` simultaneously — one rewrites the driver tree mid-merge while the other reads it, or two stack switches race on the symlink and hub restart.

Both scripts now take a single `flock` on `~/.hapi/locks/stack.lock` (shared with `hapi-restart-hub`) and publish state to `~/.hapi/driver-status.json` (atomic rewrite, schema v1). A second concurrent rebuild **or** switch **or** hub restart exits **75** (`EX_TEMPFAIL`) with a pointer at the first.

**Why one lock?** Separate rebuild/switch locks allowed a rebuild to rewrite `~/coding/hapi/driver` while another agent ran `hapi-restart-hub` or `hapi-use-driver` — the collision that bit triage + overseer on 2026-06-20.

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
# Or wait up to 10 min for the stack to clear:
# HAPI_DRIVER_WAIT_BUSY_SECS=600 hapi-driver-rebuild --build-web --verify
```

**Soup rebuild owner (policy):** one agent/session owns manifest + rebuild at a time. Peers add layers to the manifest and hand off to the **tooling/meta** session (`8c6b5a7d`) or operator — do not each run `hapi-driver-rebuild` in parallel hoping flock saves you.


**Stale state** (process died without releasing): `hapi-driver-status` prints `STALE pid=N (dead)` and the exact `rm` to clear the lock. The status file self-heals on the next successful run.

### Stale soup merge-tips (FCM / PushNotificationChannel)

Some manifest layers are **integration merge-tips** (`soup/cursor-model-error-fcm-bridge`, old `fix/soup-codex-sse-metadata-collision`, etc.) — branches created by merging two features once, then left to rot while lower layers evolve.

**Symptom:** every `hapi-driver-rebuild` fights the same file (`hub/src/push/pushNotificationChannel.test.ts`) — agents re-learn that "PushNotificationChannel now takes only four constructor arguments" because layer 1 (`feat/companion-fcm-push-api`) has the modern **per-dispatch `NotificationSendContext`** API (commit `8f870516`) while a higher merge-tip still carries the deleted **`NativeFallbackProbe` 5th constructor arg**.

**Rule:** a soup layer must be either a **single-feature branch** rebased onto upstream/main, or a **thin delta** (one cherry-pick) on top of the manifest layer it depends on — never a fat merge of an older copy of files a lower layer already owns.

**FCM bridge refresh (when push tests conflict again):**

```bash
cd ~/coding/hapi/worktrees/cursor-model-error-fcm-bridge
git reset --hard feat/companion-fcm-push-api
git cherry-pick 64583aa7   # sendModelError only; resolve fcm imports if needed
```

Do **not** fix this ad hoc in `~/coding/hapi/driver` during rebuild — fix the **branch tip**, then rebuild.

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
hapi-verify-web-dist
hapi-restart-hub
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
