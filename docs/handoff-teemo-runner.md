# Handoff: Windows runner on Teemo (Gemini agent session)

Handoff for replacing the Gemini agent session **"hapi - gemini windows installer"**. Use this doc to pick up remote-runner work without re-reading the poisoned Gemini transcript.

Related: [tiann/hapi#711](https://github.com/tiann/hapi/issues/711) (Gemini context overflow / no recovery path; Antigravity migration decision). Operator copy: [heavygee/hapi#3](https://github.com/heavygee/hapi/issues/3).

## Mission

Install **HAPI runner only** (not hub) on Windows desktop **Teemo**, connected to the Linux hub. The hub stays on Linux.

| Role | Host | Machine ID |
|------|------|------------|
| Hub | Linux (`proxmox`) | `f9bb3c9e-43fd-41ca-9e4f-a0b0414b9026` |
| Runner (target) | Windows (`Teemo`) | `teemo` (configured; see duplicate note below) |

Hub URL: `https://hapi.tail9944ee.ts.net`

## HAPI session metadata

| Field | Value |
|-------|--------|
| HAPI session ID | `b0a7208e-f35e-410a-b130-00adbf3dc040` |
| Gemini session ID | `dd9982b5-b3e6-4c1c-a9ab-87e4e7cfdbf3` |
| **Do not resume** | Context exceeded 1M tokens; transcript archived at `~/.gemini/tmp/hapi/chats/archive/` |

Start a **fresh** agent session for follow-up work.

## What the previous agent accomplished

### Windows (Teemo) — installation largely done

| Item | Status |
|------|--------|
| SSH | Works: `heavygee@100.68.171.36` (Tailscale) |
| Bun | Installed: `C:\Users\HeavyGee\.bun\bin\bun.exe` |
| HAPI clone | `H:\home\heavygee\hapi-clone` (moved from `C:\Users\HeavyGee\hapi-clone` for disk space) |
| Dependencies | `bun install` run in repo |
| Runner settings | `C:\Users\HeavyGee\.hapi\settings.json` — `machineId: teemo`, hub URL, CLI token |
| Workspace root | `h:\Users\HeavyGee\Documents\gavinc` |
| Agent CLIs | Global install attempted: `@anthropic-ai/claude-code`, `@google/gemini-cli`; `bun run tools:unpack` in `cli/` |
| Runner process | Started multiple times; logs at one point showed successful hub connect and workspace registration |
| Boot persistence | Windows scheduled-task attempts (C: then H: paths) — **not verified end-to-end** |

### Hub-side (Linux) — investigation only

- Extensive `sqlite3 ~/.hapi/hapi.db` queries on `machines` / `sessions`
- Read runner, hub socket, and install docs under `cli/` and `hub/`
- One manual DB patch: `UPDATE machines SET active=1 ... WHERE id='teemo'` (band-aid, not a fix)
- **No HAPI repo file edits** — zero write/edit operations in source

## What is still broken (operator-reported)

1. **Sessions appeared in UI but did not run agents on Windows** — user could create a session; remote execution did not behave as expected.
2. **After H: drive move**, agent reported success; user corrected: runner **missing from hub machine dropdown**, workspaces not listed.
3. **Duplicate machine registrations** in hub DB (same host, different IDs/paths):
   - `abd1f588-997a-464a-9586-4845bf3620d7` — old C: path (`C:\Users\HeavyGee\hapi-clone\cli`)
   - `teemo` — current H: path (`H:\home\heavygee\hapi-clone\cli`)
4. **Windows agent toolchain not verified** — user asked whether Cursor, Codex, Gemini, Claude are installed and on PATH for runner spawn; investigation incomplete.
5. **Gemini session died** on context overflow before dropdown/connection issues were resolved.

## Live state at handoff time (2026-05-26)

Checked after the Gemini session ended:

- **Windows:** `bun.exe` running (Services session — likely scheduled task)
- **Settings:** `machineId: teemo`, hub URL present in `C:\Users\HeavyGee\.hapi\settings.json`
- **Hub DB:** both `teemo` and `abd1f588-...` show `active=1` with the same workspace root — stale duplicate may confuse UI

Treat "process is up" as necessary but not sufficient; validate hub socket, dropdown, and spawn end-to-end.

## Key paths and commands

```
Linux hub config:     ~/.hapi/settings.json
Hub DB:               ~/.hapi/hapi.db

Windows SSH:          heavygee@100.68.171.36
Windows HAPI tree:    H:\home\heavygee\hapi-clone\cli
Windows HAPI home:    C:\Users\HeavyGee\.hapi\
Runner settings:      C:\Users\HeavyGee\.hapi\settings.json
Workspace root:       h:\Users\HeavyGee\Documents\gavinc
Bun:                  C:\Users\HeavyGee\.bun\bin\bun.exe
Runner logs:          C:\Users\HeavyGee\.hapi\logs\*-runner.log

Example runner start (from H: install):
  cd H:\home\heavygee\hapi-clone\cli
  bun src/index.ts runner start --workspace-root h:\Users\HeavyGee\Documents\gavinc
```

Environment on Windows (also in settings file):

- `HAPI_API_URL=https://hapi.tail9944ee.ts.net`
- `CLI_API_TOKEN` — see `C:\Users\HeavyGee\.hapi\settings.json` (do not commit)

## Recommended next steps

1. **Verify runner ↔ hub** — tail `*-runner.log` on Windows; confirm hub receives live updates for `teemo`, not just DB `active=1`.
2. **Remove stale machine row** — deactivate or clean up `abd1f588-997a-464a-9586-4845bf3620d7` if it is the obsolete C: registration.
3. **Audit Windows agent toolchain** — `where cursor`, `where codex`, `claude --version`, `gemini --version`; install anything required for flavors you intend to spawn remotely.
4. **End-to-end spawn test** — create a remote session on `teemo` with workspace `h:\Users\HeavyGee\Documents\gavinc`; confirm an agent process starts on Windows and produces output.
5. **Boot persistence** — inspect scheduled task name/state; ensure logon task points at `H:\home\heavygee\hapi-clone\cli` and reconnects to hub after reboot.
6. **Fresh agent session** — do not resume Gemini session `dd9982b5-...`; see [tiann/hapi#711](https://github.com/tiann/hapi/issues/711) for context-limit background.

## User prompt timeline (abbreviated)

| # | Intent |
|---|--------|
| 1 | Install runner on LAN Windows box; hub stays on Linux |
| 2 | Configure runner to connect to this hub (Tailscale-aware) |
| 3 | Sessions show in UI but do not run; investigate Windows toolchain |
| 4 | Run `hapi runner start --workspace-root h:\Users\Heavygee\Documents\gavinc` |
| 5 | Confirm runner after H: move; enable restart at boot |
| 6 | Reassess — runner not registered, workspaces missing after move |
| 7–9 | Machine ID `abd1f588` vs display name `teemo`; rename to `teemo` |
| 10 | Runner no longer in dropdowns |
| 11+ | "continue" / retry — blocked by Gemini context/quota errors |

## What was not done

- No durable, verified boot + reconnect story
- No proof that remote agent execution works on Teemo
- No HAPI code changes or PR from this workstream
- Dropdown / duplicate-machine issue left unresolved when the Gemini session died
