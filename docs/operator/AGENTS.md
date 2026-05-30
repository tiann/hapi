# AGENTS.md (operator fork)

Work style: telegraph; noun-phrases ok; drop grammar;

**Canonical agent guide for `heavygee/hapi`.** Upstream `tiann/hapi` ships root `AGENTS.md` - **this fork deletes that file** and keeps everything here. Never PR this path or a root `AGENTS.md` change to upstream.

Prefer progressive loading: this file → root `README.md` → package READMEs → `docs/plans/` for voice/integration depth.

---

## Meta: what this fork is

**HAPI is an agent-corralling platform** - local-first remote control for CLI coding agents (Claude Code, Codex, Cursor Agent, Gemini, OpenCode). Extension of upstream **[tiann/hapi](https://github.com/tiann/hapi)** (AGPL-3).

| Layer | Role |
|-------|------|
| **Upstream HAPI** | Multi-agent hub, PWA, Telegram, ElevenLabs voice, session sync |
| **Our layer** | Voice-first modality, deterministic mode state, optional `AGENT_NOTIFY_SUMMARY`, multi-agent fleet ops from phone while AFK |
| **Legacy reference** | CursorVox, CursorRemote - mine patterns, do not rebuild parallel stacks |

**North star:** *Gardening while agents work* - [`docs/plans/2026-05-23-voice-agent-state-integration.md`](../plans/2026-05-23-voice-agent-state-integration.md) §14.

---

## Upstream relationship

```text
upstream  →  https://github.com/tiann/hapi.git
origin    →  https://github.com/heavygee/hapi.git
```

- Extend upstream; PR-sized slices; default path unchanged when new code off
- **Never modify maintainer canon** in upstream PRs - see § Upstream file boundaries
- **Upstream PR branches** start from `upstream/main` only - product code diffs, nothing fork-local

---

## Strategic direction: voice-first

ElevenLabs ConvAI today: handoff OK, readback weak, payment, no mode machine. Target: pluggable voice modality + hub-owned state. Plan: `docs/plans/2026-05-23-voice-agent-state-integration.md`. Do **not** port CursorVox `dispatch_agent.py` as state owner.

---

## Operator docs map

| Doc | Purpose |
|-----|---------|
| **`docs/operator/AGENTS.md`** | This file (fork agent canon) |
| [`docs/tooling/new-feature-intake.md`](../tooling/new-feature-intake.md) | **New behavior requests** — discovery, spawn handoff, soup vs clean, gates before operator test |
| `docs/tooling/driver-soup.md` | Daily driver manifest, `hapi-active`, worktrees |
| `docs/plans/*` | Integration plans, PR A-F; peer agent: `2026-05-30-peer-agent-offering.md` |
| `docs/operator/xr/*` | **XR only (private):** work graph + mindmap visualization epic — start at `xr/work-graph-and-visualization.md` |
| `docs/operator-local-tooling.md` | `localdocs/`, machine indexes |
| `docs/dogfood/*.md` | Voice evidence for upstream PR bodies |

---

## Upstream PR series

| PR | Scope |
|----|-------|
| **A** | Voice readback - `contextFormatters.ts`, `voiceHooks.ts` |
| **B** | ElevenLabs archive - `hub/src/voice/`, `voice.ts` |
| **C** | Optional `AGENT_NOTIFY_SUMMARY` |
| **D** | Mode state + modality wrapper |
| **E** | Local OpenAI backend (after #401) |
| **F** | Web import picker |

Coordinate **#401**, **#640**. Details §16 in integration plan.

---

## Upstream file boundaries

### Never touch in upstream-bound PRs

`AGENTS.md`, `CONTRIBUTING.md`, `LICENSE`, `SECURITY.md`, root `README.md`, `.github/*`, `website/`, `docs/operator/*`, `docs/plans/*`

PR branch sanity check before push:

```bash
git fetch upstream
git diff --name-only upstream/main...HEAD | grep -E '^(AGENTS\.md|CONTRIBUTING|docs/operator|docs/plans)' && echo STOP || echo OK
```

### Fork-only (stay on `origin/main`, not in upstream PRs)

- `docs/operator/AGENTS.md` (this file)
- `docs/plans/*`, `docs/operator-local-tooling.md`
- `.cursor/rules/operator-fork.mdc`
- Root `.gitattributes` (`AGENTS.md merge=ours` - fork merge hygiene)
- Absence of root `AGENTS.md` (deleted on fork)

### Keeping a clean tree after upstream sync

One-time per clone:

```bash
git config merge.ours.driver true
```

Fork root `.gitattributes` keeps **`AGENTS.md` deleted** when merging `upstream/main` (ours = fork side).

If `AGENTS.md` reappears after a rebase anyway:

```bash
git rm -f AGENTS.md
git commit -m "chore(fork): drop upstream AGENTS.md (canonical copy in docs/operator/)"
```

**Upstream PR branches:** branched from `upstream/main` - root `AGENTS.md` exists on the branch but **leave it untouched**; your PR diff must not include it.

---

## Upstream PR voice (diffident contributor)

PR prose = humble first-timer; work = first-class. Silent checklist: rebase, tests, default path note, no fork docs in diff.

Never in upstream PRs: AI disclosure, fork strategy, internal plans, canon edits.

See prior skeleton in git history or integration plan §16.9 - Summary / Problem / Approach / Testing / Related / Questions.

---

## Voice mode states (gardening)

`idle_warm|cold`, `align_intent`, `await_confirm`, `executing_async` (silence), `reporting`, `blocked`, `report_refresh`. Ack only after hub queues. Optional `AGENT_NOTIFY_SUMMARY` - parse when present; `~/coding/agent-notify/ACTUALSPEC.md`.

---

## Git workflow

### Two branches, two purposes

| Branch | Base | Purpose |
|--------|------|---------|
| **`main`** on `origin` (fork) | upstream + fork-only commits | Local dev; operator docs; deleted `AGENTS.md` - **never open a PR to tiann from this branch** |
| **`fix/…`, `feat/…`** | **`upstream/main` only** | Upstream PRs - diff must be product code only |

Committing fork metadata on fork `main` is **fine**. It only leaks into an upstream PR if you branch wrong.

**Safe (upstream PR):**

```bash
git fetch upstream
git checkout -b fix/voice-ready-inline-summary upstream/main   # NOT fork main
# ... edits in cli/hub/web/shared only ...
git diff --name-only upstream/main...HEAD   # must not list AGENTS.md, docs/operator/, docs/plans/
git push -u origin fix/voice-ready-inline-summary
gh pr create --repo tiann/hapi --head heavygee:fix/voice-ready-inline-summary
```

**Unsafe (will PR the deletion + operator docs):**

```bash
git checkout -b fix/voice main    # fork main includes fork-only commits
gh pr create --repo tiann/hapi     # BAD - ancestry includes AGENTS.md deletion
```

If you started from fork `main` by mistake, re-cut before push:

```bash
git fetch upstream
git checkout -b fix/voice-ready-inline-summary upstream/main
git cherry-pick <commit-sha>      # product commits only, not fork config commits
```

Or: `git rebase --onto upstream/main upstream/main fix/voice` after ensuring fork-only commits aren't in the chain.

### Sync fork main with upstream

```bash
git fetch upstream && git checkout main && git merge upstream/main   # AGENTS.md stays deleted (merge=ours)
git rm -f AGENTS.md 2>/dev/null; true
```

One-time per clone: `git config merge.ours.driver true`

Before `git add` on **PR branches**: no `localdocs/`, secrets, `docs/operator/`, `docs/plans/`.

---

## HAPI baseline (from upstream `tiann/hapi` AGENTS.md)

Inlined here so the fork does not need root `AGENTS.md`. When upstream updates their copy, manually port relevant technical deltas into this section.

### What is HAPI?

Local-first platform for running AI coding agents (Claude Code, Codex, Gemini, Cursor Agent, OpenCode) with remote control via web/phone. CLI wraps agents and connects to hub; hub serves web app and handles real-time sync.

### Repo layout

```
cli/     - CLI binary, agent wrappers, runner daemon
hub/     - HTTP API + Socket.IO + SSE + Telegram bot
web/     - React PWA for remote control
shared/  - Common types, schemas, utilities
docs/    - VitePress documentation site
website/ - Marketing site
```

Bun workspaces; `shared` consumed by cli, hub, web.

### Architecture overview

```
┌─────────┐  Socket.IO   ┌─────────┐   SSE/REST   ┌─────────┐
│   CLI   │ ──────────── │   Hub   │ ──────────── │   Web   │
│ (agent) │              │ (server)│              │  (PWA)  │
└─────────┘              └─────────┘              └─────────┘
```

**Data flow:**
1. CLI spawns agent, connects to hub via Socket.IO
2. Agent events → CLI → hub → DB + SSE broadcast
3. Web subscribes to SSE `/api/events`
4. User actions → Web → hub REST → RPC → CLI → agent

**Voice path (ElevenLabs default):**

```text
Browser WebRTC ↔ ElevenLabs ConvAI → client tools → hub queue → coding agent CLI
                                                      ↑ voiceHooks contextual updates
```

### Reference docs

- `README.md`, `cli/README.md`, `hub/README.md`, `web/README.md`, `docs/guide/`, `CONTRIBUTING.md` (read only)

### Shared rules

- No backward compatibility required
- Pragmatism; avoid overengineering; tests only when needed
- TypeScript strict; Bun from repo root; `@/*` → `./src/*`; 4-space; Zod in `shared/src/schemas.ts`

### Common commands

```bash
bun typecheck
bun run test
bun run dev
bun run build:single-exe
```

### Key source dirs

**CLI (`cli/src/`):** `api/`, `claude/`, `codex/`, `agent/`, `runner/`, `commands/`, `modules/`, `ui/`

**Hub (`hub/src/`):** `web/routes/`, `socket/handlers/cli/`, `sync/`, `store/`, `sse/`, `telegram/`, `notifications/`, `config/`, `visibility/`, **`voice/`** (operator extensions)

**Web (`web/src/`):** `routes/`, `components/`, `hooks/`, `api/client.ts`, **`realtime/`** (voice)

**Shared (`shared/src/`):** `types.ts`, `schemas.ts`, `socket.ts`, `messages.ts`, `modes.ts`, **`voice.ts`**

### Voice integration seams

| Concern | Path |
|---------|------|
| Voice prompt + tools | `shared/src/voice.ts` |
| Default transport | `web/src/realtime/RealtimeVoiceSession.tsx` |
| Client tools | `web/src/realtime/realtimeClientTools.ts` |
| Context feed | `voiceHooks.ts`, `contextFormatters.ts` |
| Token API | `hub/src/web/routes/voice.ts` |
| Notify + mode hook | `hub/src/socket/handlers/cli/sessionHandlers.ts` |
| Outbound messages | `hub/src/sync/messageService.ts` |

### Testing

Vitest; `*.test.ts` next to source; hub + cli tests; no web tests currently.

### Common tasks

| Task | Key files |
|------|-----------|
| Add CLI command | `cli/src/commands/`, `cli/src/index.ts` |
| Add API endpoint | `hub/src/web/routes/`, `hub/src/web/index.ts` |
| Add Socket.IO event | `hub/src/socket/handlers/cli/`, `shared/src/socket.ts` |
| Modify session logic | `sessionCache.ts`, `syncEngine.ts` |
| Modify messages | `messageService.ts` |
| Voice readback / mode | `contextFormatters.ts`, `sessionHandlers.ts`, `hub/src/voice/` |
| Attach agent chat | `machines.ts`, `scripts/attach-agent-chat.sh` |

### Important patterns

- **RPC:** `rpc-register` + `rpcGateway.ts`
- **Versioned updates:** stale rejected
- **Session modes:** `local` vs `remote`
- **Permission modes:** `default`, `acceptEdits`, `bypassPermissions`, `plan`
- **Namespaces:** `CLI_API_TOKEN:<namespace>`

### Critical thinking

1. Fix root cause (not band-aid).
2. Unsure: read more code; ask w/ short options.
3. Conflicts: call out; pick safer path.
4. Unrecognized changes: assume other agent; focus your changes.
5. **Upstream first** - general fixes → upstream PR.
6. **Maintainer canon read-only** - never PR edits to `AGENTS.md`, `CONTRIBUTING.md`, root `README.md`.
7. **Fork agent doc is here only** - root `AGENTS.md` must not exist on fork `main`.

---

## New functionality intake

When the operator asks for **new product behavior**, follow [`docs/tooling/new-feature-intake.md`](../tooling/new-feature-intake.md) end-to-end.

**Orchestrator** completes steps 1-3 (and usually 4-5), then spawns a **feature peer** with the mandatory handoff block in that doc (completed steps vs peer-owned steps).

**Feature peer** implements in `~/coding/hapi-<name>` — not in `~/coding/hapi-driver` by hand. Pass §6 (tests, cold review, Playwright) **before** asking the operator to browser-test. Upstream PR only after operator dogfood approval (§8).

**Instruction roots:** agents read **this file** and tooling docs from the **`~/coding/hapi` workspace**, plus `~/coding/AGENTS.local.md`. The **daily driver** (`~/coding/hapi-driver`) is what **`hapi-active` runs** — not where IDE rules come from unless that tree is the opened workspace.

---

## Peer spawn handoff (required)

Do not spawn a feature peer without filling the template in [`new-feature-intake.md` §0](../tooling/new-feature-intake.md#0--feature-peer-agent--mandatory-handoff). Minimum: parent session id, playback summary, which steps are **DONE** vs **peer-owned**, worktree path, demo topology (soup vs clean).
