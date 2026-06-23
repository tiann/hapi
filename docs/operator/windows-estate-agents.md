# Windows HAPI estate agents

Windows agents run through **HAPI remote Cursor CLI** (`cursor agent` on Teemo, spawned by the runner) — not the desktop Cursor IDE. Rules and hooks still load from the **Windows user profile**:

- **Rules:** `C:\Users\HeavyGee\.cursor\rules\*.mdc` (`alwaysApply: true` applies every agent turn)
- **Hooks:** `C:\Users\HeavyGee\.cursor\hooks.json` — CLI supports `beforeShellExecution` (mechanical muzzle)

Workspace is often `h:\Users\heavygee\Documents\gavinc\misc` — it does **not** contain Linux repo rules from `~/coding/hapi/.cursor/rules/`. User-level rules are the enforcement surface for HAPI CLI sessions.

Install/refresh: `scripts/tooling/hapi-install-windows-cursor-muzzle.sh` (from Proxmox). After install, the next agent turn picks up files; no IDE restart required, but the session must receive a new prompt.

**HAPI CLI reality check (2026-06-21):** Teemo sessions use `cursor agent` over **ACP** with `preferredPermissionMode: yolo`. In that path:

- **User rules** (`~/.cursor/rules/*.mdc`) load — the Windows agent confirmed `hapi-windows-estate.mdc` in self-test.
- **`beforeShellExecution` hooks often do not fire** for Agent Shell in ACP/HAPI remote sessions (audit log never appended during live self-test). Do not rely on hooks alone.
- **`yolo` auto-approves shell** at the HAPI `PermissionAdapter` layer before Cursor hooks run.

**Durable enforcement:** CLI `PermissionAdapter` production-mutation guard (denies even in yolo) — worktree `feat/windows-production-mutation-guard`. Ship to Teemo runner after merge/rebuild.

**Spawn discipline:** Windows estate peers should start in **`default` permission mode**, not yolo, until the CLI guard is on the runner build.

## 2026-06-20 incident (why this doc exists)

- **Session:** `78cf225f` (Windows triage)
- **Misread:** "see video in web UI" → rebind Linux production hub
- **Action:** `kill` systemd listener, `hapi-driver-db-prep`, `nohup bun run src/index.ts` from worktree on `:3006`, DB downgrade, `git reset --hard` on driver
- **Effect:** Rogue hub served worktree bundle; systemd crash-loop; soup features missing until recovery

## Two-layer muzzle

### 1. Always-applied Cursor rule (Windows user rules)

- **Canonical source:** `scripts/tooling/cursor-rules/hapi-windows-estate.mdc`
- **Installed to:** `C:\Users\HeavyGee\.cursor\rules\hapi-windows-estate.mdc`
- **Retired:** `hapi-source.mdc` (paths-only, no production fence)

### 2. Mechanical hook (Windows `beforeShellExecution`)

- **Script:** `scripts/tooling/windows/hapi-production-mutation-guard.mjs` (run via `bun` — PowerShell `-File` drops stdin in Cursor CLI)
- **Installed to:** `%USERPROFILE%\.cursor\hooks\hapi-production-mutation-guard.mjs`
- **Blocks:** `ssh server '...'` (and `wsl ssh`) when remote command matches kill/nohup/stack-switch/DB-prep/manual-hub patterns

Linux Cursor (Proxmox workspace) gets the bash twin:

- `scripts/tooling/hapi-production-mutation-guard.sh` via `hapi-install-cursor-hooks.sh`

## Install / refresh (operator)

From Proxmox mirror:

```bash
chmod +x ~/coding/hapi/scripts/tooling/hapi-install-windows-cursor-muzzle.sh
~/coding/hapi/scripts/tooling/hapi-install-windows-cursor-muzzle.sh
```

Then **restart Cursor on Teemo** (hooks + rules reload).

Override env (interactive operator shell only — not agent piped stdin):

- `HAPI_OPERATOR_PRODUCTION_MUTATION_OVERRIDE=1`

## Orchestrator spawn template (Windows estate tasks)

Paste into every Windows peer handoff:

```markdown
## Scope lock
- **Windows only:** refresh Teemo runner / CLI / PATH. Read-only Linux diagnostics OK.
- **Never** mutate Linux `:3006`, `~/.hapi/hapi.db`, driver soup, or `hapi-hub.service` via SSH.
- Pre-soup browser proof: `hapi-peer-stack up <name>` (:3100+) — not manual nohup on :3006.
- Any `REFUSE:` from hapi tooling → stop and report stderr; do not bypass.
```

## Allowed vs forbidden (quick reference)

**OK over SSH:** `git status`, `curl :3006/health`, `systemctl status`, `pgrep`, `hapi-driver-status`, read-only logs.

**Never over SSH:** `kill`/`nohup` on hub, `hapi-use-worktree`, `hapi-use-driver`, `hapi-driver-db-prep`, `hapi-driver-rebuild --activate`, `systemctl stop|restart hapi-hub`, `git reset --hard` on driver, DB replace/downgrade.

## Related

- `docs/tooling/new-feature-intake.md` — peer spawn handoff
- `docs/tooling/driver-soup.md` — soup promotion path
- `scripts/tooling/lib/hub-port-guard.sh` — activation-time rogue listener check
- `docs/handoff-teemo-runner.md` — Teemo runner install context
