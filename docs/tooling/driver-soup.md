# Daily Driver + Merge-Train Worktrees

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
hapi-driver-rebuild --build-web     # also build web/dist
hapi-driver-rebuild --verify        # typecheck + test
hapi-driver-rebuild --activate      # calls hapi-use-worktree (hub + runner; prompts)
```

**Prefer** rebuild without `--activate`, then when ready:

```bash
hapi-use-driver   # restarts hapi-hub + hapi-runner together
```

### When upstream moves

1. Edit manifest (drop merged PRs, add new ones)
2. `hapi-driver-rebuild --build-web --verify`
3. Garden smoke: `curl -sf http://127.0.0.1:3006/health` + quick VR/web check
4. Log drift in `~/coding/hapi-garden/GARDEN_LOGBOOK.md` if API changed

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
| `hapi-driver-rebuild` | Rebuild soup from manifest |
| `hapi-worktree-create` | New PR worktree (+ merge train) |
| `hapi-use-worktree <path>` | Swing `hapi-active` + restart **hub + runner** |
| `hapi-use-driver` | Swing to daily driver soup |
| `hapi-runner-from-active` | systemd helper — runner CLI from `hapi-active/cli` |
| `hapi-sessions-health.sh` | Session monitor |

Sources: `scripts/tooling/` in repo; installed to `~/.local/bin/`.

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
