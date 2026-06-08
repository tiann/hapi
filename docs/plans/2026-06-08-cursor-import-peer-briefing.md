# Peer briefing: upstream Cursor import (ACP-only) implementation

**Spawned:** 2026-06-08 by orchestrator session `4a06f0a7-5376-4a8e-83bb-8bd7e48c1db9`
**Worktree:** `/home/heavygee/coding/hapi/worktrees/cursor-import-acp`
**Branch:** `cursor-import-to-hapi` (off `upstream/main` @ `1f92a31b` "Release version 0.20.1")
**Machine id:** `f9bb3c9e-43fd-41ca-9e4f-a0b0414b9026`

---

## Parent

- **Orchestrator HAPI session:** `4a06f0a7-5376-4a8e-83bb-8bd7e48c1db9` — `https://hapi.tail9944ee.ts.net/sessions/4a06f0a7-5376-4a8e-83bb-8bd7e48c1db9`
- **Orchestrator role:** "legacy chat attachments (resurrected)" — owns the fork-private reattachment skill, closed PR #36 (the resurrect script bridge), filed the strategic plan, then handed implementation to you.
- **Operator request (verbatim, the trigger):** *"in a reasonable world, this would be a PR to do for cursor what codex does - but specifically importing into the acp version, whatever that means, not legacy and auto-upgrade - it would skip that route - essentially having cursor in HAPI have ANYTHIGN to do with the prior nonACP mode would be a non-starter."* followed by *"legacy will go away entirely at some point, we cannot rely on its continued existence. bollocks to everyone else, close it, keep the capability we have, but plan to being the bigger PR to folks."*

The operator has explicitly chosen the **strict ACP-only** philosophy. A chat that fails `agent acp` verify is **unimportable**, not a stream-json fallback. Hold the line on this — it is the philosophical core of the PR.

---

## Intake status (orchestrator completed)

- [x] **1 Code search** — orchestrator scanned fork-private scripts (`attach-agent-chat.ts`, `backfill-agent-transcript.ts`, `import-recovered-md.ts`, `hapi-resurrect-session.sh`). You should re-verify there's nothing on `upstream/main` for Cursor import (only codex import exists today, `#796`).
- [x] **2 Upstream search** — orchestrator confirmed: no upstream Cursor import PR exists. Codex equivalent is `tiann/hapi#796` (`codex-import-to-hapi` branch — your pattern to mirror). Operator's own RFC `tiann/hapi#732` is the discovery-and-import RFC this PR concretely executes.
- [x] **3 Playback** — already done as a written strategic plan (see "Read first" below). Operator approved by directing the spawn of this peer.
- [x] **4 Issue vs spike** — **spike first** (no upstream issue yet). Operator wants to dogfood-validate before filing.
- [ ] **5 Demo topology** — you decide. Recommendation: **clean instance** because this affects session-creation flow and the soup driver has live operator agents that mustn't be disrupted by half-built import code.

---

## Your assignment (feature peer)

**Own:** steps 1 (re-verify) → 8 (upstream PR). Specifically:

1. **Read first** (in this exact order):
   - `~/coding/hapi/docs/plans/2026-06-08-upstream-cursor-import-acp-only.md` — the strategic plan (155 lines). This is your authoritative spec.
   - This file (you're reading it).
   - `~/coding/hapi/docs/operator/AGENTS.md` — fork canon.
   - `~/coding/hapi/docs/tooling/new-feature-intake.md` — process you're inside of.
   - `~/coding/hapi/docs/tooling/driver-soup.md` — only if you choose soup topology.

2. **Re-verify upstream search.** Things move. Before writing code, `gh search prs "cursor import" --repo tiann/hapi --state all` and confirm no one is already on this. If someone is, **stop and ping orchestrator** instead of duplicating work.

3. **PRE-IMPLEMENTATION GATE — the verify-probe audit.** This is non-negotiable. Per the plan §"Pre-PR audit":
   - Run `agent acp` (initialize + session/load + tiny session/prompt) against every chat in `~/.cursor/chats/<wsh>/<uuid>/store.db`. Operator has ~300+ chats per #34's body claims.
   - Count: pass / fail / error.
   - Decision tree:
     - **≥ 95% pass rate:** ship strict ACP-only refusal contract as designed. The handful of unimportable chats become structured errors. Document specific failure modes in PR body.
     - **90–95%:** investigate each failure class. Decide per-class whether it's a fixable upstream `cursor-agent` bug or a genuinely-unimportable case. May need to ping orchestrator/operator for a call.
     - **< 90%:** **STOP**. The "ACP-only or unimportable" UX is not viable until something gives. Write up the failure modes and ping the orchestrator. Do NOT silently build a feature that fails 1-in-5 imports.
   - Use `~/coding/hapi/worktrees/cursor-import-acp/scripts/audit-cursor-acp-verify.ts` (you write it; it's the audit tool). Output to `~/coding/hapi/docs/plans/2026-06-08-cursor-acp-verify-audit.csv` (fork-private). Keep the tool runnable; it doubles as a regression check the operator can re-run when `cursor-agent` updates.

4. **#34 dependency strategy.** The plan calls for reusing `cursorLegacyMigrator.ts` from `heavygee/hapi#34` (branch `spike/cursor-legacy-to-acp-migrator`). That PR is **OPEN, not merged, not upstreamed** as of 2026-06-08. Three options:
   - **A. Wait** for #34 to merge (could be days/weeks; orchestrator session has bandwidth to land it).
   - **B. Vendor** the migrator into your branch (copy `hub/src/cursor/cursorLegacyMigrator.ts` from #34, with a comment marking it as vendored pending #34 merge upstream). Deduplicate after both PRs land.
   - **C. Reimplement** the transplant primitive inline in your import path. Cleaner separation but duplicates ~25 tests' worth of safety. Don't.
   - **Recommendation: B (vendor).** Lets you ship the import PR independently. The PR body discloses the vendored copy and links #34 as the eventual owner.
   - If you pick B, also vendor #34's tests for the migrator into your branch so the vendored code is still covered.

5. **Implementation scope** (from plan §"What this PR does"):
   - **Discovery endpoint** `GET /api/cursor/importable-sessions` — list candidates from both `~/.cursor/chats/` (legacy) and `~/.cursor/acp-sessions/` (already ACP). Return `{uuid, workspacePath, firstUserMessage, mtime, alreadyImported, importedHapiSessionId, sourceFormat}`.
   - **Import endpoint** `POST /api/cursor/import { uuid, workspacePath }` — see plan for full refusal contract. Strict: ACP row or structured error, never stream-json HAPI row.
   - **Web UI** `web/src/components/CursorSessionSyncDialog.tsx` mirroring `CodexSessionSyncDialog.tsx`. Per-row badge "ACP" or "legacy (will transplant)". Reuse `CursorMigrationBanner` from #34 for in-flight UX.
   - **CLI** `hapi cursor import <uuid> [--workspace <path>] [--list]` mirroring codex.
   - **Tests:** unit (every refusal path), integration (synthetic legacy store → import → verify ACP from birth), fault-injection (verify-failure → no HAPI row → structured error).

6. **Mirror codex shape relentlessly.** Read `web/src/components/CodexSessionSyncDialog.tsx`, the codex hub route, the codex CLI subcommand. Your PR's review velocity is proportional to how closely the shape mirrors what tiann already approved. The big delta is ACP-only refusal and the transplant invocation; everything else (UX, surfaces, naming) should be parallel.

7. **Pre-operator gates (§6 of new-feature-intake.md).** Before pinging the orchestrator:
   - `bun typecheck` + `bun run test` (and `cd web && bun run test` since web touched)
   - Cold code review on diff vs `upstream/main` — use `docs/tooling/cold-pr-review-rubric.md`
   - DB schema check (you probably don't bump `SCHEMA_VERSION` since import writes to existing tables, but verify)
   - Playwright smoke on the clean demo instance — assert the import dialog renders, lists chats, accepts an import, banner shows, session lands as ACP. Screenshot at `localdocs/playwright-runs/cursor-import-handoff.png`.
   - **Dogfood the audit yourself first**: import 3-5 real chats from operator's `~/.cursor/chats/` into the clean demo. Confirm they land as ACP, scrollback intact, can resume + send a prompt + get a reply.

8. **Operator dogfood.** Send orchestrator: demo URL (deep-link to the dialog), what to click, screenshot path, audit CSV, test output, `git diff upstream/main...HEAD` stat. Wait for explicit "ship it" before opening upstream PR.

9. **Upstream PR.** `gh pr create --repo tiann/hapi --base main`. Body should:
   - Link orchestrator's RFC `tiann/hapi#732` (operator's own filing — "Fixes #732" if appropriate).
   - Mirror `#796`'s PR body structure.
   - Disclose vendored `cursorLegacyMigrator` if you went option-B, link `heavygee/hapi#34`.
   - Include audit CSV summary (pass rate, failure breakdown) so reviewers see why ACP-only is viable.
   - **Exclude** `docs/operator/`, `docs/plans/`, root `AGENTS.md` body from the diff (fork-private; pre-push hook will block if you forget).

---

## Do NOT redo

- Strategic positioning / philosophy — locked. ACP-only or unimportable. Don't relitigate.
- Choosing to mirror codex import — orchestrator already vetted this against operator's stated intent.
- Closing PR #36 — already done (`heavygee/hapi#36` is closed, `tooling/legacy-chat-acp-alignment` branch retained).
- Operator's RFC #732 framing — read it, build to it, don't refile.

---

## Reference links

| What | Where |
|------|-------|
| Strategic plan (your spec) | `~/coding/hapi/docs/plans/2026-06-08-upstream-cursor-import-acp-only.md` |
| RFC (operator's prior filing) | `https://github.com/tiann/hapi/issues/732` |
| Codex import (your model PR) | `https://github.com/tiann/hapi/pull/796` |
| Fork auto-migrate (your primitive source) | `https://github.com/heavygee/hapi/pull/34` |
| Fork resurrect-script (retired sibling) | `https://github.com/heavygee/hapi/pull/36` (closed); branch `origin/tooling/legacy-chat-acp-alignment` retained |
| Fork canon | `~/coding/hapi/docs/operator/AGENTS.md` |
| Intake process | `~/coding/hapi/docs/tooling/new-feature-intake.md` |
| Worktree layout rule | `~/coding/hapi/.cursor/rules/worktree-layout.mdc` |
| Operator-fork rule | `~/coding/hapi/.cursor/rules/operator-fork.mdc` |

---

## Coordination contract

- **Sole owner of the worktree** `~/coding/hapi/worktrees/cursor-import-acp`. No other agent should commit there. If you discover dirty work that isn't yours, do NOT stash (see `.cursor/rules/no-stash-others-work.mdc`); ping orchestrator.
- **Do not touch** `~/coding/hapi-driver`, `~/coding/hapi/driver`, or `~/coding/hapi/upstream` worktrees. Soup driver is for live operator agents.
- **Do not** `sudo systemctl restart hapi-hub.service` — use `hapi-restart-hub` (patient drain). Better: do NOT restart the production hub at all for this work — stand up a clean instance.
- **Stack switches** (`hapi-use-worktree`) yank live agents. Don't use unless operator explicitly tells you to switch the daily driver to this branch.
- **Progress reporting:** one-line `<STATE> | <DELTA> | <NEXT> | <ASK>` per turn per the global rule. Long output goes to fork-private files; reports stay terse.
- **Block immediately** on: audit pass rate < 90%, vendored migrator drift from #34 upstream, codex import shape divergence you can't justify, any case that would produce a stream-json HAPI row.

---

## Done definition

| Stage | Meaning |
|-------|---------|
| Ready for orchestrator | Audit done, gates §6 pass, demo URL works, 3-5 real chats imported as ACP, scrollback intact |
| Orchestrator approved | Orchestrator pings operator with summary; operator approves dogfood OR sends back to fix |
| Operator approved | Explicit "ship it" message |
| Shipped | `gh pr create` against `tiann/hapi` `main`, PR linked to RFC #732, audit CSV in PR body |

You're not "done" until the upstream PR is open and the pr-review-loop has started.

---

## First three actions for you (in order)

1. `cd /home/heavygee/coding/hapi/worktrees/cursor-import-acp && git log --oneline -1` — confirm you're on `cursor-import-to-hapi` at `1f92a31b`.
2. Read the strategic plan: `~/coding/hapi/docs/plans/2026-06-08-upstream-cursor-import-acp-only.md`. Then re-read this briefing.
3. Write the audit tool (`scripts/audit-cursor-acp-verify.ts`) and run it. The pass-rate number is the gate that decides whether the rest of the work happens.

Send the orchestrator your one-line status when the audit completes. If audit gates you (< 90%), block. If audit passes, proceed to upstream search re-verification and implementation.

Go.
