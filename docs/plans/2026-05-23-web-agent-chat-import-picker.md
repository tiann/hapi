# Plan: Web-based import picker for existing agent chats

**Status:** Draft  
**Related:** [voice integration plan](./2026-05-23-voice-agent-state-integration.md)  
**Operator need:** Attach pre-HAPI agent conversations (Cursor, Claude, Codex, etc.) to the HAPI session list without restarting work or running CLI one-liners per repo.

---

## Problem

HAPI only lists sessions created through the hub (CLI `hapi *`, web spawn, runner RPC). Chats started outside HAPI (`agent`, `claude`, `codex` in a terminal) are invisible until manually wrapped.

Today the operator workaround is:

```bash
# CLI per project (local-first; blocks terminal unless remote spawn)
cd ~/coding/myproject && hapi cursor resume <chatId>

# Batch remote attach (May 2026 operator script)
~/coding/hapi/localdocs/operator/attach-existing-agent-sessions.sh
```

That script uses `POST /api/machines/:id/spawn` with **`resumeSessionId`** (added to `SpawnSessionRequestSchema` May 2026). Web UI does not expose this yet.

---

## Goal

**Browse workspace → pick agent flavor → pick discovered local chat → attach to HAPI** (remote runner spawn), with:

- No duplicate HAPI session if same agent chat already attached
- Clear label (project path + chat title/first message + mtime)
- Optional pin/rename in HAPI metadata after attach

---

## Discovery sources (read-only, machine-local via runner RPC)

| Agent | Discovery | Resume id field |
|-------|-----------|-----------------|
| **Cursor** | `agent ls` (TTY) or parse `~/.cursor/projects/home-heavygee-coding-*/agent-transcripts/` + optional `store.db` titles | Cursor chat UUID |
| **Claude** | Latest `~/.claude/projects/-home-heavygee-coding-<slug>/*.jsonl` | Claude session UUID |
| **Codex** | Scan `~/.codex/sessions/**/rollout-*.jsonl` `session_meta.payload.id` filtered by `cwd` | Codex thread id |
| **Gemini / OpenCode / Kimi** | Existing HAPI scanner patterns in `cli/src/*/utils/*Scanner*` | flavor-specific metadata |

**Runner constraint:** discovery runs on the machine with workspace roots; hub never reads `~/.cursor` directly.

---

## Proposed UX (web)

1. **Entry:** Session list empty state or `/browse` → **Import existing chat**
2. **Step 1:** Machine (if multiple) + directory picker (existing browse UI)
3. **Step 2:** Agent flavor tabs (cursor | claude | codex | …)
4. **Step 3:** List discovered chats:
   - Title heuristic: first user message / sqlite title / "Untitled"
   - Subtitle: `mtime`, message count estimate, agent id prefix
   - Badge: **Already in HAPI** if hub metadata matches `cursorSessionId` / etc.
5. **Attach:** `POST /api/machines/:id/spawn` with `{ directory, agent, resumeSessionId }`
6. **Result:** Navigate to new session; show note that **full transcript backfill is not guaranteed** (agent context intact; HAPI history may be sparse until new traffic)

---

## API / hub work (upstream-shaped)

### PR F1 - Expose resume on spawn (done locally May 2026)

- `shared/src/apiTypes.ts`: `resumeSessionId?: string` on `SpawnSessionRequestSchema`
- `hub/src/web/routes/machines.ts`: forward to `engine.spawnSession`
- Tests: spawn route passes resume id to RPC

### PR F2 - Discover local agent chats (new)

- `GET /api/machines/:id/agent-chats?directory=&agent=cursor|claude|codex`
- Runner RPC: `list-agent-chats` executes flavor-specific discovery in cwd
- Returns `{ chats: [{ id, title, updatedAt, cwd, alreadyAttachedSessionId? }] }`
- Security: path must be under runner workspace roots (same as spawn)

### PR F3 - Web import wizard

- `web/src/components/ImportAgentChat/` wizard
- Uses F1 + F2; no new hub session store tables

---

## Edge cases

| Case | Handling |
|------|----------|
| **Named chat not literal on disk** (e.g. operator says "login2oidc") | Search titles/first-message heuristics; show match confidence; allow manual id paste |
| **`agent ls` needs TTY** | Runner uses transcript mtime fallback; optional `script`/`CI=1` probe |
| **specstory `agent` alias** | Document `command agent` or full cursor-agent path in runner env |
| **Duplicate attach** | Disable Attach if `alreadyAttachedSessionId`; offer Open existing |
| **Wrong cwd** | Warn when discovery cwd ≠ picker directory |

---

## Dogfood attach map (May 2026 operator batch)

| Project | Agent | Resume id | Notes |
|---------|-------|-----------|-------|
| sparling | cursor | `d2b0370c-3e29-4462-9296-f984f0614aef` | Latest transcript mtime |
| sparling | claude | `12d15516-adb9-49cf-8e7a-9bb18ede3246` | Latest `.jsonl` in claude projects dir |
| meister-export-web | cursor | `c5add90a-2389-48c1-a9d6-10d24195435c` | |
| server-setup | cursor | `3054d570-fe5d-4d0d-8d4e-9f5ac2a45dea` | OIDC/htaccess modernization thread (operator label: login2oidc) |
| ExcuseMe | cursor | `f0f6291f-7ecc-4bf3-9c9d-c09bfb831ff7` | |
| gtxr | codex | `019e4b52-a96d-7283-9098-3a7ff8599a54` | From rollout `session_meta` cwd match |
| local-speech-agent | cursor | `ba02940f-f488-489b-9a2d-c00a0880cfe2` | |
| YourChores | cursor | `9118c502-4253-42a8-8d4d-0ce123c1f519` | |

Script: `localdocs/operator/attach-existing-agent-sessions.sh` (operator-local; see `docs/operator-local-tooling.md`)

---

## Non-goals

- Full historical transcript import into HAPI message store (separate backfill project)
- Replacing agent-native session pickers inside Cursor/Claude UIs
- Requiring AGENT_NOTIFY or voice changes

---

## Success criteria

- Operator attaches 8 chats without CLI one-liners
- All appear in web session list as **remote** runner sessions
- Agent continues prior context (smoke: send "where did we leave off" via web)
- Web picker PR F2+F3 removes need for hardcoded script
