# Plan: Unified multi-agent session import picker

**Status:** Active (peer-driven, see briefing below)
**Filed:** 2026-06-16
**Worktree:** `~/coding/hapi/worktrees/agent-import-picker`
**Branch:** `feat/agent-session-import-picker` (off `upstream/main` @ `93d00414`)
**Supersedes:** [`2026-06-08-upstream-cursor-import-acp-only.md`](2026-06-08-upstream-cursor-import-acp-only.md) (cursor-only scope, now folded into this multi-agent shape)
**Builds on:** [`2026-05-23-web-agent-chat-import-picker.md`](2026-05-23-web-agent-chat-import-picker.md) (the original multi-flavor picker vision; resurrected and tightened)
**Upstream context:**
- Codex importer (`tiann/hapi#796`) — **merged**; the foundation we generalize.
- Cursor legacy→ACP migrator (`tiann/hapi#844` + regression fix `#877`) — **merged**; supplies the transplant primitive `hub/src/cursor/cursorLegacyMigrator.ts` we call as a library.
- RFC `tiann/hapi#732` — operator's own filing; **OPEN**; the eventual PR cites `Fixes #732`.

---

## Operator request (verbatim, 2026-06-16)

> "I want this cursor import picker to exist - specifically I want it to expand on the existing codex one - identical to it, introduce an optionality for cursor vs codex (and later other agents)"

Translation: stop building a parallel cursor-only picker. Generalize the codex importer that already shipped (`#796`) into a **flavor-aware import dialog + endpoints** that handle codex today, cursor next, and pluggably extends to claude / gemini / opencode later. Same UX shape; one canonical import surface.

---

## State of the world (changed since 2026-06-08)

| Thing | Status | Location |
|-------|--------|----------|
| Codex import endpoints | **Shipped upstream** | `hub/src/web/routes/codexDesktop.ts` (`/codex/sessions`, `/codex/sync-session`, etc.) |
| `CodexSessionSyncDialog` | **Shipped upstream** | `web/src/components/CodexSessionSyncDialog.tsx` |
| Codex CLI subcommand | **Shipped upstream** | `cli/src/commands/...` (codex side) |
| Cursor on-resume migrator | **Shipped upstream** (`#844`, `#877`) | `hub/src/cursor/cursorLegacyMigrator.ts` + `acpVerifyProbe.ts` |
| Cursor ACP verify-probe audit harness | **Vendored on this branch** | `scripts/audit-cursor-acp-verify.ts` (committed `30d95b49`) |
| Cursor ACP-import refusal contract | **Spec'd, gate cleared** | `2026-06-08-upstream-cursor-import-acp-only.md`, `2026-06-08-cursor-acp-verify-audit-summary.md` (391/391 = 100% pass) |
| Multi-agent picker | **Not built** | (this plan) |

---

## What this PR does

Generalizes the codex importer into a **multi-flavor agent session import** surface, with cursor as the second flavor and the architecture pluggable for the rest. Three layers:

### 1. Hub — generalized routes + per-flavor adapters

Two acceptable shapes. The peer decides based on what minimizes risk to the existing codex flow:

**Shape A — flavor-aware generalized endpoints (preferred long-term):**

```
GET  /api/agent-sessions/importable?agent=codex|cursor
POST /api/agent-sessions/import           { agent, sessionIds[], workspacePath? }
POST /api/agent-sessions/restart-desktop  { agent }   # codex desktop only today
```

Existing `/codex/*` endpoints stay as deprecated aliases (one release cycle) so any external caller keeps working.

**Shape B — parallel `/cursor/*` endpoints mirroring `/codex/*` exactly:**

`/cursor/sessions`, `/cursor/sync-session`, etc. Shared types + helpers extracted into `hub/src/web/routes/_agentImport/`. No deprecation. More files but zero migration cost.

Internal structure either way:

```
hub/src/web/routes/agentImport/
  index.ts              # router registration
  codexImporter.ts      # extracted from codexDesktop.ts; same behavior
  cursorImporter.ts     # NEW: discovery in ~/.cursor/chats + ~/.cursor/acp-sessions, calls cursorLegacyMigrator for legacy stores
  types.ts              # AgentImporter interface, AgentSessionSummary, refusal types
  __tests__/
```

Cursor flavor is **strict ACP-only**. The refusal contract from the prior plan stays intact:

- `verify_load_failed` — `agent acp` `session/load` failed on the transplanted store
- `missing_on_disk_store` — no `store.db` at the expected path
- `target_already_exists` — ACP directory already exists (race or partial prior import)
- `already_imported` — HAPI session row already references this UUID
- `agent_binary_not_found` — `agent` not on PATH
- `verify_timeout` — probe ran longer than configurable timeout
- `corrupted_store` — SQLite open or schema check failed

No stream-json HAPI row is ever created by the cursor import path. Operator gets an ACP session or a structured error. The audit gate (391/391 = 100% pass on operator's library) shows zero unimportable cases in practice.

### 2. Web — `AgentSessionImportDialog`

Rename `CodexSessionSyncDialog.tsx` → `AgentSessionImportDialog.tsx` with:

- Agent flavor selector at top (codex | cursor today; placeholder for future flavors)
- Per-flavor row metadata:
  - **codex:** cwd + cliVersion + last user message (current behavior)
  - **cursor:** workspace path + first user message + protocol badge (`ACP` / `legacy → will transplant`)
- Per-flavor confirm action wired to the right endpoint
- Cursor-flavor in-flight UI reuses any banner primitive that survived `#844` upstream (verify in the codebase; if absent, build a small inline status row)
- Cursor refusal cases shown with structured error + "skip" action

The existing `CodexSessionSyncDialog` test patterns port over; add cursor-flavor parallels.

### 3. CLI — `hapi import <agent>`

Generalize the codex CLI subcommand into:

```
hapi import codex <id> [--workspace ...]
hapi import codex --list
hapi import cursor <uuid> [--workspace ...]
hapi import cursor --list
```

Both subcommands share argparse + output formatting. Existing codex CLI command stays as an alias (or moves silently — peer's call based on existing code shape).

### 4. Tests

- **Per-flavor unit:** every refusal path mocked (cursor); existing codex coverage preserved.
- **Integration (opt-in `CURSOR_IMPORT_INTEGRATION=1`):** synthetic legacy store via `#844`'s `buildSyntheticLegacyStore` fixture → import endpoint → assert ACP from birth, messages backfilled, source untouched.
- **Fault-injection:** mutate synthetic store to fail verify → assert no HAPI row, structured error.
- **Web dialog:** flavor switch, per-flavor row rendering, confirm dispatch.
- **Regression:** the existing codex import tests must still pass unchanged (or update expected paths if the rename moves them).

---

## Audit harness (already in branch)

`scripts/audit-cursor-acp-verify.ts` — standalone bun script vendored at branch HEAD. Walks every legacy chat at `~/.cursor/chats/<wsh>/<uuid>/store.db`, drives the same `agent acp` initialize + session/load that the import endpoint will run, emits CSV with per-chat outcomes.

Re-run when `cursor-agent` updates its on-disk schema:

```bash
bun scripts/audit-cursor-acp-verify.ts --concurrency 4
```

Last run (2026-06-08, 391 chats): 100.0% pass; CSV + summary live in operator-private docs (not in PR diff).

---

## Refusal contract (cursor flavor only — operator-facing copy)

When a legacy cursor chat fails verify-probe, the import endpoint returns a structured JSON error with an enum reason and human-readable message. The dialog renders this as a per-row error chip with a "skip" action. **The legacy `store.db` is untouched and no HAPI row is created.** No fallback to stream-json; ever.

Reasoning: `cursor-agent`'s stream-json mode is on the deprecation curve (`#799` migrated new sessions to ACP; `#844` migrates legacy on resume). Producing stream-json HAPI rows on import would actively create technical debt. The audit shows the strict refusal hits zero actual cases, so the UX cost is theoretical.

---

## Mirror codex shape relentlessly

PR review velocity scales with how closely the diff parallels what `tiann` already approved in `#796`. Read those files first; deviate only where the cursor flavor genuinely needs different behavior (verify-probe, ACP-only refusal). The flavor-selector UI and per-flavor row metadata are the only intentional additions to codex's known-good shape.

---

## Test plan (sketch — peer expands)

- Unit: every cursor refusal path; codex paths regression-only
- Integration: synthetic legacy store round-trip via the import endpoint; assert ACP from birth + messages backfilled + source untouched
- Fault-injection: corrupt store → corrupted_store error; valid store with bad meta → verify_load_failed
- Web: flavor switch, per-flavor row metadata, confirm dispatch; ensure existing codex tests still pass after rename
- Smoke: 3-5 real chats from operator's library (cursor) + 1-2 codex sessions (regression) imported on a clean demo instance, scrollback intact, can resume + send a prompt + get a reply

---

## Coordination with shipped pieces

- **`#844` migrator:** called as a library from `cursorImporter`. Already merged; vendoring obsolete.
- **`#877` migrator path-priority fix:** already in `upstream/main`; nothing to do.
- **Codex `#796`:** the foundation. Refactor must not break its tests or behavior.
- **RFC `#732`:** PR body cites `Fixes #732`. RFC body covers cursor + codex + later agents; this PR concretely executes its cursor + codex portions.

---

## Decision tree (per-import)

```
operator picks agent flavor in dialog
        |
        +--- codex --> existing codex import path (preserved)
        |
        +--- cursor --> hub-side: is this UUID already at ~/.cursor/acp-sessions/?
        |                  |
        |             yes -+-> synthesize HAPI row (protocol=acp), backfill messages, done
        |                  |
        |             no  -+-> invoke cursorLegacyMigrator (#844)
        |                       |
        |                  ok   -+-> create HAPI row (protocol=acp), backfill, done
        |                       |
        |                  fail -+-> structured error, NO HAPI row, legacy store untouched
        |
        +--- (future) claude / gemini / opencode --> per-flavor importer module
```

One picker UI. Per-flavor backend. No protocol fork in the user flow.

---

## Done definition

| Stage | Meaning |
|-------|---------|
| Ready for orchestrator | §6 gates pass, demo URL works, smoke imports succeed (≥3 cursor + ≥1 codex), screenshot at `localdocs/playwright-runs/agent-import-picker.png` |
| Operator approved | Explicit "ship it" message after dogfood |
| Shipped upstream | `gh pr create --repo tiann/hapi --base main`, body cites `Fixes #732` and audit headline (391/391 cursor pass), excludes operator-private docs |

Peer is not "done" until the upstream PR is open and `pr-review-loop.md` has started.
