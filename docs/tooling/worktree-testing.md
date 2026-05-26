# Worktree Testing — Feature Branches Without Polluting Main

## Problem

A running systemd service needs a stable directory to execute from. If you do feature
work directly in `~/coding/hapi` (the primary checkout), you end up with:

- Dirty working tree when you need a clean upstream/main reference
- Risk of accidentally committing local-only operator files (`.env`, `AGENTS.local.md`, etc.)
- No isolation between the **daily driver soup** and PR formulation worktrees
- Multiple agents working in the same directory at the same time causing conflicts

**See [driver-soup.md](./driver-soup.md)** for the three-layer model (mirror / driver / PR worktrees).

## Solution: Symlink Indirection

```
hapi-hub.service
    ↓ WorkingDirectory
~/coding/hapi-active   ←── symlink, swappable
    ↓ currently points to
~/coding/hapi-driver     (daily driver soup — target default)
    or
~/coding/hapi-<feature>  (worktree, under test)
```

The service units always point at `~/coding/hapi-active`. Swapping what that symlink
points to (and restarting **hub + runner**) is all it takes to test any branch, with zero
edits to systemd files.

State lives entirely outside the repo at `~/.hapi/` (SQLite DB, JWT secret, tokens,
logs). Worktree swaps are transparent to it.

---

## One-Time Setup (already done on this machine)

### 1. Systemd units use the symlink path

`/etc/systemd/system/hapi-hub.service`:
```ini
[Service]
User=heavygee
WorkingDirectory=/home/heavygee/coding/hapi-active/hub
EnvironmentFile=/home/heavygee/.hapi/hub.env
ExecStart=/home/heavygee/.bun/bin/bun run src/index.ts
Restart=on-failure
RestartSec=5
```

`/etc/systemd/system/hapi-runner.service` — `ExecStart=/home/heavygee/.local/bin/hapi-runner-from-active` (CLI from `hapi-active/cli`, not npm global).

### 2. `hapi-active` symlink created

```bash
ln -sfn ~/coding/hapi-driver ~/coding/hapi-active   # daily driver default
```

### 3. Hub env is canonical at `~/.hapi/hub.env`

`hub/.env` in both main checkout and every worktree is a symlink to it:
```bash
ln -s ~/.hapi/hub.env ~/coding/hapi/hub/.env
```

Never create a separate `.env` with different keys.

### 4. Helper scripts installed at `~/.local/bin/`

Symlinks to `scripts/tooling/` in this repo: `hapi-use-worktree`, `hapi-use-driver`, `hapi-worktree-create`, `hapi-driver-rebuild`, `hapi-runner-from-active`. Legacy alias: `hapi-use-main` → same as `hapi-use-driver`.

---

## Daily Workflow

### Create a new feature worktree

```bash
# Preferred — prints hapi-use-worktree command when done
hapi-worktree-create <feature-name> --branch feat/<feature-name>

# Manual — always branch from upstream/main
git worktree add ~/coding/hapi-<feature-name> -b feat/<feature-name> upstream/main
ln -s ~/.hapi/hub.env ~/coding/hapi-<feature-name>/hub/.env
```

**Naming convention:** flat under `~/coding/` — `~/coding/hapi-<feature-name>`, never
a subdirectory.

### Develop in the worktree

```bash
cd ~/coding/hapi-<feature-name>
# edit, commit — all normal git operations work
# PRs must be created from here, not from ~/coding/hapi
git branch --show-current   # confirm you're on the right branch before staging
```

### Test live against the running service

```bash
hapi-use-worktree ~/coding/hapi-<feature-name>
```

This script:
1. Validates `hub/` exists in the target path
2. Creates `hub/.env` symlink if missing
3. Warns and optionally builds web (`bun run build`) if `web/dist/index.html` is absent
4. Swings `~/coding/hapi-active` to the worktree (`ln -sfn`)
5. Restarts **`hapi-hub.service` and `hapi-runner.service`** (prompts first)

### Restore to daily driver

```bash
hapi-use-driver
# legacy alias: hapi-use-main
```

Swings `hapi-active` back to `~/coding/hapi-driver` and restarts **hub + runner** (same prompt as any stack switch).

### Verify after switch

```bash
readlink -f ~/coding/hapi-active    # must equal your worktree path
curl -sf http://127.0.0.1:3006/health
systemctl is-active hapi-hub.service hapi-runner.service
```

---

## Script source (canonical)

Do not copy script bodies into this doc — they drift. Source of truth:

| Installed | Repo path |
|-----------|-----------|
| `~/.local/bin/hapi-use-worktree` | `scripts/tooling/hapi-use-worktree.sh` |
| `~/.local/bin/hapi-use-driver` | `scripts/tooling/hapi-use-driver.sh` |
| `~/.local/bin/hapi-use-main` | legacy wrapper → `hapi-use-driver` (not `~/coding/hapi`) |
| `~/.local/bin/hapi-worktree-create` | `scripts/tooling/hapi-worktree-create.sh` |
| `~/.local/bin/hapi-runner-from-active` | `scripts/tooling/hapi-runner-from-active.sh` |

`hapi-use-worktree` restarts **`hapi-hub.service` and `hapi-runner.service`** from the same tree. Non-interactive switch requires `HAPI_STACK_SWITCH_YES=1`.

---

## Side Effects and Caveats

**`garden-web.service`** — runs separately in `~/coding/hapi-garden/`, proxies to
hub on `:3006`. It is completely unaffected by worktree swaps.

**State (`~/.hapi/`)** — the SQLite database, JWT secret, and session tokens all live
outside the repo. Swapping worktrees does not wipe sessions or require re-auth.

**Web build** — the hub serves the web UI from `web/dist/`. If you have frontend
changes in your worktree, build before swinging: `cd ~/coding/hapi-<feature>/web && bun run build`.
`hapi-use-worktree` will warn you if `dist/index.html` is missing.

**Multiple agents** — each agent should work in its own named worktree. Never have two
agents editing the same worktree simultaneously. The main checkout (`~/coding/hapi`)
is read-only reference — no agent commits there directly.

**Cleanup** — when a feature branch is merged, remove its worktree:
```bash
git worktree remove ~/coding/hapi-<feature-name>
# or if it has uncommitted changes:
git worktree remove --force ~/coding/hapi-<feature-name>
```

---

## Adapting for Other Agents (Cursor, etc.)

The mechanism is shell + symlinks — fully agent-agnostic. Read **`AGENTS.local.md`** and [driver-soup.md](./driver-soup.md) at session start.

What agents need to know:
1. **`~/coding/hapi-driver` is read-only between rebuilds** — only `hapi-driver-rebuild` may change it (no edits, no `cp`, no local commits). Update `~/.config/hapi/driver-manifest.yaml` then rebuild.
2. **Never formulate upstream PRs in `~/coding/hapi-driver`** — use `~/coding/hapi-<name>` worktrees
3. **`~/coding/hapi` primary checkout** should track `upstream/main` (mirror) — see [driver-soup.md](./driver-soup.md)
4. **Create PR worktrees** with `hapi-worktree-create` (prints the `hapi-use-worktree` line) or `git worktree add`
5. **Rebuild daily driver** with `hapi-driver-rebuild` — edit `~/.config/hapi/driver-manifest.yaml` first
6. **Swing live stack** with `hapi-use-worktree` / `hapi-use-driver` — **restarts hub + runner, kills sessions**; **operator must confirm** at `Proceed? [y/N]` (do not auto-answer unless explicitly told)
7. **`git branch --show-current` before every commit and `gh pr create`**
8. After "ready to demo", confirm `readlink -f ~/coding/hapi-active` matches the worktree — editing alone does not change `:3006`
