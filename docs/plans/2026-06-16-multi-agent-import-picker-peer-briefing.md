# Peer briefing: unified multi-agent session import picker

**Spawned:** 2026-06-16 by orchestrator (operator-facing Cursor session at `~/coding/hapi/worktrees/cursor-import-acp`, due to be torn down once you ack this brief)
**Worktree:** `/home/heavygee/coding/hapi/worktrees/agent-import-picker`
**Branch:** `feat/agent-session-import-picker` (off `upstream/main` @ `93d00414` "Release version 0.20.2 + auto perm mode (#879)")
**Initial commit on branch:** `30d95b49 chore(scripts): add cursor-acp verify-probe audit harness` (vendored from prior peer)

---

## Parent

- **Orchestrator:** the Cursor session that wrote this briefing. Operator's HAPI session URL is at `https://hapi.tail9944ee.ts.net/sessions/4a06f0a7-5376-4a8e-83bb-8bd7e48c1db9` (the prior cursor-import-acp peer); this revised scope was decided 2026-06-16.
- **Operator request (verbatim, the trigger):** *"I want this cursor import picker to exist - specifically I want it to expand on the existing codex one - identical to it, introduce an optionality for cursor vs codex (and later other agents)"*
- **Authoritative spec:** [`docs/plans/2026-06-16-multi-agent-import-picker.md`](2026-06-16-multi-agent-import-picker.md). Read this FIRST. It supersedes the cursor-only plan from 2026-06-08 and resurrects the multi-agent vision from 2026-05-23.

---

## Intake status (orchestrator completed)

- [x] **1 Code search** — codex import shipped upstream at `hub/src/web/routes/codexDesktop.ts` (`/codex/sessions`, `/codex/sync-session`, etc.) and `web/src/components/CodexSessionSyncDialog.tsx`. Cursor migrator shipped at `hub/src/cursor/cursorLegacyMigrator.ts` + `acpVerifyProbe.ts`. No multi-agent picker exists.
- [x] **2 Upstream search** — `tiann/hapi#796` (codex import) **merged**; `tiann/hapi#844` (cursor migrator) **merged**; `tiann/hapi#877` (migrator path-priority fix) **merged**; `tiann/hapi#732` (RFC: import external agent sessions) **OPEN** — your eventual PR cites `Fixes #732`.
- [x] **3 Playback** — operator approved this scope on 2026-06-16 (see Operator request above).
- [x] **4 Issue vs spike** — **spike first** off `upstream/main`. RFC `#732` is the eventual `Fixes` target.
- [ ] **5 Demo topology** — your call. Recommended: **clean instance** because the refactor touches the existing codex import flow and you don't want to risk dragging the daily soup driver into half-built state. See `docs/tooling/new-feature-intake.md` §5 for the clean-instance recipe.

---

## Pre-PR audit gate — ALREADY PASSED, do not re-run unless cursor-agent updates

The cursor flavor's strict ACP-only refusal contract was gated by a pre-PR audit on 2026-06-08. **391/391 chats (100.0%) passed `agent acp` initialize + session/load.** The audit summary lives at `docs/plans/2026-06-08-cursor-acp-verify-audit-summary.md` (operator-private; reference but do NOT copy into the upstream PR diff). The CSV with per-chat outcomes is alongside it.

The audit harness `scripts/audit-cursor-acp-verify.ts` is committed at branch HEAD. Re-run only if `cursor-agent` updates its on-disk schema between now and PR open:

```bash
bun scripts/audit-cursor-acp-verify.ts --concurrency 4
```

Skip the re-run unless cursor-agent has bumped a major version.

---

## Your assignment (feature peer)

**Own:** steps 1 (re-verify) → 8 (upstream PR). Specifically:

1. **Read first** in this exact order:
   - [`docs/plans/2026-06-16-multi-agent-import-picker.md`](2026-06-16-multi-agent-import-picker.md) — your authoritative spec.
   - This file (you're reading it).
   - [`docs/plans/2026-05-23-web-agent-chat-import-picker.md`](2026-05-23-web-agent-chat-import-picker.md) — the original multi-flavor vision; folds in.
   - [`docs/plans/2026-06-08-upstream-cursor-import-acp-only.md`](2026-06-08-upstream-cursor-import-acp-only.md) — the cursor-only predecessor; SUPERSEDED but the refusal contract section is still binding for the cursor flavor.
   - [`docs/plans/2026-06-08-cursor-acp-verify-audit-summary.md`](2026-06-08-cursor-acp-verify-audit-summary.md) — gate evidence.
   - `docs/operator/AGENTS.md` — fork canon.
   - `docs/tooling/new-feature-intake.md` — the process you're inside of.

2. **Re-verify upstream search.** Things move (codex import shipped between RFC and now). `gh search prs "agent import OR multi-agent import OR session import" --repo tiann/hapi --state open` and confirm no one else is on this exact scope. If someone is, **stop and ping orchestrator** instead of duplicating work.

3. **Architecture call (yours to make).** Two acceptable shapes per the strategic plan:
   - **A.** Refactor codex routes into flavor-aware `/api/agent-sessions/...` with `?agent=` selector; keep `/codex/*` as deprecated aliases for one cycle.
   - **B.** Add parallel `/cursor/*` endpoints mirroring `/codex/*`; extract shared types/helpers into `hub/src/web/routes/_agentImport/`.

   Pick whichever minimizes risk to the existing codex flow. **Document your choice in the PR body** so reviewers see the trade-off you considered.

4. **Implementation scope** (from spec §"What this PR does"):
   - **Hub:** generalized importable + import endpoints; per-flavor adapters (`codexImporter`, `cursorImporter`); cursor adapter wraps the upstream `cursorLegacyMigrator` library.
   - **Web:** rename `CodexSessionSyncDialog` → `AgentSessionImportDialog` (or wrap; peer's call), add flavor selector, per-flavor row metadata, cursor in-flight + refusal UX.
   - **CLI:** generalize codex subcommand into `hapi import <agent> ...`.
   - **Tests:** per-flavor unit + integration + fault-injection; web dialog with flavor switch; existing codex tests must still pass.

5. **Strict ACP-only enforcement (cursor flavor).** The refusal contract is binding:
   - `verify_load_failed`, `missing_on_disk_store`, `target_already_exists`, `already_imported`, `agent_binary_not_found`, `verify_timeout`, `corrupted_store`
   - No HAPI row created on refusal. Legacy `store.db` untouched. No fallback to stream-json. Ever.
   - The 391/391 audit shows zero unimportable cases on operator's library, so the strictness is theoretical-cost-only. Don't relitigate this with reviewers.

6. **Mirror codex shape.** Read `web/src/components/CodexSessionSyncDialog.tsx`, the `/codex/*` route handlers, and the codex CLI subcommand source. Your PR's review velocity scales with parallelism to what `tiann` already approved in `#796`.

7. **Pre-operator gates** (`docs/tooling/new-feature-intake.md` §6):
   - `bun typecheck` and `bun run test` (cli + hub + web)
   - Cold code review on diff vs `upstream/main` using `docs/tooling/cold-pr-review-rubric.md`
   - DB schema check (this PR likely doesn't bump `SCHEMA_VERSION` — verify)
   - Playwright smoke on the clean demo: dialog renders, flavor switch works, lists chats per flavor, accepts an import, banner shows, session lands as expected. Screenshot at `localdocs/playwright-runs/agent-import-picker.png`.
   - **Dogfood yourself first**: import 3-5 cursor chats and 1-2 codex chats from the operator's libraries on the clean demo. Confirm scrollback intact, can resume + send a prompt + get a reply.

8. **Operator dogfood handoff.** Send orchestrator: demo URL with deep-link, what to click, screenshot path, audit reference (the existing 391/391 evidence; no need to re-run), test output, `git diff upstream/main...HEAD --stat`. Wait for explicit "ship it" before opening upstream PR.

9. **Upstream PR.** `gh pr create --repo tiann/hapi --base main`. Body should:
   - Cite `Fixes #732`.
   - Mirror `#796`'s PR body structure.
   - Document the architecture choice from step 3 (shape A vs B).
   - Cite the cursor audit headline (391/391 = 100% pass) as the "why ACP-only is safe to ship" evidence; link is to operator-private docs that you DO NOT include in the diff.
   - **Exclude** `docs/operator/`, `docs/plans/`, `localdocs/`, root operator-private artifacts. The pre-push leak scanner enforces this.

---

## Do NOT redo

- **Audit gate** — already passed at 100.0% on 2026-06-08 with the harness now committed at branch HEAD. Don't re-run unless cursor-agent's on-disk schema changed.
- **Strict ACP-only refusal contract** — locked. Operator's call. Don't relitigate with reviewers.
- **Mirroring codex shape** — orchestrator pre-vetted; just mirror it.
- **RFC #732 framing** — read it; build to it; don't refile.
- **Vendoring `cursorLegacyMigrator`** — obsolete since `#844` merged upstream. Import as a library.

---

## Reference links

| What | Where |
|------|-------|
| Strategic plan (your spec) | `~/coding/hapi/docs/plans/2026-06-16-multi-agent-import-picker.md` |
| RFC (operator's prior filing) | https://github.com/tiann/hapi/issues/732 |
| Codex import (your foundation) | https://github.com/tiann/hapi/pull/796 (merged) |
| Cursor migrator (your transplant primitive) | https://github.com/tiann/hapi/pull/844 (merged) + https://github.com/tiann/hapi/pull/877 (regression fix, merged) |
| Cursor-only predecessor plan (SUPERSEDED) | `~/coding/hapi/docs/plans/2026-06-08-upstream-cursor-import-acp-only.md` |
| Multi-agent precursor plan | `~/coding/hapi/docs/plans/2026-05-23-web-agent-chat-import-picker.md` |
| Audit gate evidence | `~/coding/hapi/docs/plans/2026-06-08-cursor-acp-verify-audit-summary.md` (+ `.csv`) |
| Audit harness | `scripts/audit-cursor-acp-verify.ts` (in this branch, commit `30d95b49`) |
| Fork canon | `~/coding/hapi/docs/operator/AGENTS.md` |
| Intake process | `~/coding/hapi/docs/tooling/new-feature-intake.md` |
| Worktree layout rule | `~/coding/hapi/.cursor/rules/worktree-layout.mdc` |
| Operator-fork rule | `~/coding/hapi/.cursor/rules/operator-fork.mdc` |

---

## Coordination contract

- **Sole owner of the worktree** `~/coding/hapi/worktrees/agent-import-picker`. No other agent should commit there. If you discover dirty work that isn't yours, do NOT stash (see `.cursor/rules/no-stash-others-work.mdc`); ping orchestrator.
- **Do not touch** `~/coding/hapi/driver`, `~/coding/hapi/upstream`, or any other worktree. Soup driver is for live operator agents.
- **Do not** `sudo systemctl restart hapi-hub.service` — use `hapi-restart-hub` (patient drain). Better: do NOT restart the production hub at all for this work — stand up a clean instance per §5 of new-feature-intake.md.
- **Stack switches** (`hapi-use-worktree`) yank live agents. Don't use unless operator explicitly tells you to switch the daily driver to this branch.
- **Progress reporting:** one-line `<STATE> | <DELTA> | <NEXT> | <ASK>` per turn per the global rule. Long output goes to operator-private files; reports stay terse.
- **Block immediately** on:
  - Architecture choice (shape A vs B) needing operator input — make a default call, document it, proceed; only block if you can't see a defensible default
  - Codex test regression you can't explain
  - Any case that would produce a stream-json HAPI row on the cursor path
  - Pre-push leak scanner flagging operator-private content in the upstream PR diff

---

## Done definition

| Stage | Meaning |
|-------|---------|
| Ready for orchestrator | Audit gate already passed, §6 gates pass, demo URL works, ≥3 cursor + ≥1 codex chats imported successfully on clean demo, scrollback intact |
| Orchestrator approved | Orchestrator pings operator with summary; operator approves dogfood OR sends back to fix |
| Operator approved | Explicit "ship it" message |
| Shipped | `gh pr create` against `tiann/hapi` `main`, PR linked to RFC #732, audit headline (391/391) in PR body, operator-private docs NOT in diff |

You're not "done" until the upstream PR is open and the pr-review-loop has started.

---

## First three actions for you (in order)

1. `cd /home/heavygee/coding/hapi/worktrees/agent-import-picker && git log --oneline -3` — confirm you're on `feat/agent-session-import-picker` with the audit harness committed at HEAD.
2. Read the strategic plan and the predecessor plans listed in step 1 above. Do not skim.
3. Read the upstream codex import code (`hub/src/web/routes/codexDesktop.ts` + `web/src/components/CodexSessionSyncDialog.tsx` + the codex CLI subcommand). Mirror its shape; deviate only where the spec says to.

When you have a concrete architecture proposal (shape A vs B from step 3 of your assignment) and have read the codex code, ping the orchestrator with one-line `<STATE> | <DELTA> | <NEXT> | <ASK>` and proceed.

Go.
