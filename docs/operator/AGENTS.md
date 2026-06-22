# AGENTS.md (operator fork)

Work style: telegraph; noun-phrases ok; drop grammar;

**Canonical agent guide for `heavygee/hapi`.** Upstream `tiann/hapi` ships root `AGENTS.md` - **this fork deletes that file** and keeps everything here. Never PR this path or a root `AGENTS.md` change to upstream.

Prefer progressive loading: **[feature-work-lifecycle.md](../tooling/feature-work-lifecycle.md)** (sole workflow doc) → this file (fork identity, upstream PR) → root `README.md` → package READMEs.

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

**Fork `main` mirror:** after upstream activity run `hapi-sync-fork-main` (in `scripts/tooling/`) and `git push origin main`. Primary checkout `~/coding/hapi` must contain **upstream product code + fork docs** — not docs-only drift. `hapi-driver-rebuild` refuses if `main` is behind `upstream/main`.

- Extend upstream; PR-sized slices; default path unchanged when new code off
- **Never modify maintainer canon** in upstream PRs - see § Upstream file boundaries
- **Upstream PR branches** start from `upstream/main` only - product code diffs, nothing fork-local

### Upstream collaborator status (heavygee on tiann/hapi)

`heavygee` has **`write`** permission on `tiann/hapi` (verify: `gh api repos/tiann/hapi/collaborators/heavygee/permission`). This is unusual for what is otherwise documented as a fork relationship and post-dates the fork canon. **Status: awaiting explicit guidance from @tiann on the intended scope of this access.**

Until @tiann signals otherwise, default to **fork-contributor discipline** (PRs from `upstream/main`-based branches via `hapi-pr-create`, comments and reviews welcome on others' PRs, no direct writes to upstream branches or other people's work).

**What we self-permit absent guidance:**

- **Label management** on `tiann/hapi` issues and PRs - low-risk, reversible, helpful for triage
- **Pushing to PR branches via `maintainerCanModify`** *only when* (a) the PR has `maintainerCanModify: true`, (b) we have coordinated with the PR author first (comment + reasonable response window), and (c) we are addressing a clear stall (conflicts, no author iteration, no maintainer review). Stays attributed: author's commits keep their authorship; our rebase / fix commits add `Co-authored-by:` lines

**What we explicitly do NOT do absent guidance:**

- Direct push to `tiann/hapi:main` or any other upstream branch (use the normal PR flow)
- Merging PRs (ours or others')
- Force-pushing to others' PR branches
- Closing issues or PRs we don't own
- Editing PR titles / bodies / descriptions on others' PRs
- Modifying repo settings, branch protections, secrets, or `.github/workflows/*`
- Acting on behalf of @tiann in any communication with contributors
- Granting or revoking access to others
- Triggering / dismissing workflows on others' PRs

If @tiann clarifies broader (or narrower) scope, revise this section.

---

## Strategic direction: voice-first

ElevenLabs ConvAI today: handoff OK, readback weak, payment, no mode machine. Target: pluggable voice modality + hub-owned state. Plan: `docs/plans/2026-05-23-voice-agent-state-integration.md`. Do **not** port CursorVox `dispatch_agent.py` as state owner.

---

## Operator docs map

| Doc | Purpose |
|-----|---------|
| **`docs/operator/AGENTS.md`** | This file (fork agent canon) |
| [`docs/tooling/new-feature-intake.md`](../tooling/new-feature-intake.md) | **New behavior requests** — discovery, spawn handoff, soup vs clean, gates before operator test |
| `docs/tooling/driver-soup.md` | Daily driver manifest, `hapi-active`, worktrees, **coordination (`hapi-driver-status`) and DB jiu-jitsu** |
| `docs/plans/*` | Integration plans, PR A-F; peer agent: `2026-05-30-peer-agent-offering.md` |
| `docs/operator/xr/*` | **XR only (private):** work graph + mindmap visualization epic — start at `xr/work-graph-and-visualization.md` |
| `docs/operator-local-tooling.md` | `localdocs/`, machine indexes |
| `docs/dogfood/*.md` | Voice evidence for upstream PR bodies |

---

## Stack-switch tooling: agents do NOT touch live `:3006`

**Full workflow, mermaid, and agent permission matrix:** [`feature-work-lifecycle.md`](../tooling/feature-work-lifecycle.md) — **only place that defines this.**

**Forbidden agent tool-calls** (stack path change — kills sessions): `hapi-use-worktree`, `hapi-use-driver`, `hapi-driver-rebuild --activate`, `hapi-watch-activate-driver` from tool shells.

**Allowed for soup dogfood when already on driver:** see lifecycle § Agent permission matrix — summary: `hapi-driver-rebuild --build-web [--verify]`, `hapi-verify-web-dist`, **`hapi-restart-hub`** (hub/cli). Not `hapi-use-driver`.

**Raw `sudo systemctl restart hapi-hub`:** forbidden — use `hapi-restart-hub`. Three-layer block + TTY-gated bypass: `.cursor/rules/operator-fork.mdc` § sudo systemctl. Outage pattern: agents running `hapi-use-worktree` from inside their worktree (2026-06-10, 2026-06-11) — don't be the third.

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
hapi-worktree-create voice-ready --branch fix/voice-ready-inline-summary
cd ~/coding/hapi/worktrees/voice-ready
# ... edits in cli/hub/web/shared only ...
git diff --name-only upstream/main...HEAD   # must not list AGENTS.md, docs/operator/, docs/plans/
git push -u origin fix/voice-ready-inline-summary
hapi-pr-create --title "fix(voice): inline ready summary" --body-file body.md
```

The wrapper enforces base = `upstream/main`, runs `check-operator-leaks.sh` on the diff and body, and requires a `Closes #N` keyword in the body (bypass with `--no-closes-required` for spike PRs or discussion-only links).

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

Or use the wrapper: `hapi-sync-fork-main` (handles fork-only commits, runs `hapi-branch-audit --on-merge` at the end so any branches whose PRs just landed upstream get flagged for cleanup).

One-time per clone: `git config merge.ours.driver true`

Before `git add` on **PR branches**: no `localdocs/`, secrets, `docs/operator/`, `docs/plans/`.

### One branch per tracked item (enforced via audit)

Every long-lived local branch must map to exactly one tracked item: an open upstream PR, an upstream issue, an upstream discussion, or a fork-only PR for staging. Branches without that mapping rot — silently bitrotting, silently re-doing work that already merged, silently piling up.

Three rules:

1. **Before opening a PR**, the linked tracker (issue / discussion / fork issue) must exist. File it first if needed. Use `gh-public-body-check.sh` on the issue body before `gh issue create`.
2. **Open upstream PRs via `hapi-pr-create`** (wrapper around `gh pr create`). It refuses PRs from `main`/`driver/integration`/infra branches, runs `check-operator-leaks.sh` on the diff + body, and rejects bodies that lack a `Closes #N` / `Fixes #N` / `Resolves #N` keyword. Bypass with `--no-closes-required` only for spike PRs or discussion-only links.
   - **Fork-side cold-review stage is mandatory before opening an upstream PR for non-trivial changes.** Push the branch to origin, open a fork PR (`gh pr create --repo heavygee/hapi --base main --head fix/X --draft`) so the fork review bot weighs in. Iterate until the bot has no remaining findings. Apply the `cold-review-clean` label to the fork PR as the explicit "I've addressed or accepted bot findings" signal. Close the fork PR. **Then** run `hapi-pr-create` for the upstream PR. The goal: every upstream PR is green on first bot review — no public feedback-then-fix cycle. Bypass with `--skip-fork-stage` only for trivial changes (typo, debug log removal, etc.) where bot review adds no value. See [`repo-layout-and-dev-flow.md` §3.1-§3.2](./repo-layout-and-dev-flow.md#31-why-the-fork-stage-comes-first) for the full rationale.
3. **`hapi-branch-audit`** runs read-only over every local branch and classifies each as `OK`, `OK-LINKED` (body has `#N` ref like a discussion, no auto-close), `NO-LINKS`, `MERGED` (delete candidate), `NO-TRACKING`, `STALE-BEHIND` (>30 commits behind upstream/main), `DETACHED-WT`. Run `hapi-branch-audit` to see the full table; `--quiet` shows only branches needing action and exits non-zero. Runs automatically after `hapi-sync-fork-main` and via the `post-merge` git hook on `main`.

Infra branches exempted from audit: `main`, `driver/integration`, `upstream-main-test`, `garden/r3f-poc`.

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

**Feature peer** implements in **`~/coding/hapi/worktrees/<name>`** (created via `hapi-worktree-create <name> --branch <branch>`) — not in `~/coding/hapi/driver` by hand. For pre-operator web gates, use **`hapi-peer-stack up`** (isolated hub on `3100–3199`, registry `~/.hapi-peer/`) — not soup on `:3006`. Pass §6 (tests, cold review, Playwright on peer stack) **before** asking the operator to browser-test. Upstream PR only after operator dogfood approval (§8). Use **`hapi-pr-create`** to open the PR — it enforces the closes-keyword + leak scan.

**Instruction roots:** agents read **this file** and tooling docs from the **`~/coding/hapi` workspace**, plus `~/coding/AGENTS.local.md`. The **daily driver** (`~/coding/hapi/driver`) is what **`hapi-active` runs** — not where IDE rules come from unless that tree is the opened workspace.

**Canonical worktree layout (2026-06-01 onward):** see [`.cursor/rules/worktree-layout.mdc`](../../.cursor/rules/worktree-layout.mdc) and [`docs/plans/2026-06-01-hapi-folders-reorganization.md`](../plans/2026-06-01-hapi-folders-reorganization.md). Summary: `~/coding/hapi/{driver,upstream,worktrees/<name>}` — never create new worktrees at `~/coding/hapi-<name>/` or `~/coding/hapi-worktrees/<name>/` (those are pre-reorg legacy locations being drained).

---

## Peer spawn handoff (required)

Do not spawn a feature peer without filling the template in [`new-feature-intake.md` §0](../tooling/new-feature-intake.md#0--feature-peer-agent--mandatory-handoff). Minimum: parent session id, playback summary, which steps are **DONE** vs **peer-owned**, worktree path, demo topology (soup vs clean).
