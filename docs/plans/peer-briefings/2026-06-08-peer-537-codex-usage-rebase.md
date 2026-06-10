# Peer briefing - #537 Codex usage indicator: rebase + soup-adopt (local fork)

**Branch:** `feat/codex-usage-indicator-rebased` (currently at `d54f896d`, dsus4wang's head)
**Worktree:** `~/coding/hapi/worktrees/codex-usage-rebased/`
**Upstream PR being shadowed:** [tiann/hapi#537](https://github.com/tiann/hapi/pull/537) by @dsus4wang
**Umbrella tracker:** [tiann/hapi#846](https://github.com/tiann/hapi/issues/846) (cross-flavor agent budget gauges - this PR is the Codex piece)
**Demo topology:** **soup** - this is going on the daily driver after gates pass
**Agent:** Cursor / auto / yolo - act autonomously, don't ask permission for ordinary file operations

---

## Parent

- Orchestrator Cursor session: `d1ceebab-27db-4601-9b9d-00a5c5bc7c3f`
- Operator request: "spawn a PEER agent (cursor, auto, yolo) and begin the work on the local fork, using our local development requirements? we anticipate we will be doing it all ourselves"

## Critical constraint - DO NOT PUSH BACK TO UPSTREAM YET

A polite enquiry comment was posted to [PR #537](https://github.com/tiann/hapi/pull/537#issuecomment-4651046152) on 2026-06-08 offering to rebase + push via maintainer-edit. **Response window: 7 days, expires 2026-06-15.**

Outcomes that determine the eventual push-back path (orchestrator decides; NOT you):

| @dsus4wang response | Action (orchestrator drives, not peer) |
|---|---|
| Welcomes the help | Push the rebased branch back to `dsus4wang/codex/codex-usage-indicator` via `git push --force-with-lease dsus4wang HEAD:codex/codex-usage-indicator` - updates PR #537 in place |
| Declines | Drop upstream push entirely. Keep work on soup only. Document in plan. |
| Silence past 2026-06-15 | Same as "welcomes" - proceed with maintainer-edit push |

Until then: **all your work is local-fork-only**. Do not push to `dsus4wang/*`, do not file a new PR, do not comment on #537 yourself. If you finish all the work before 2026-06-15, report ready and stand down on the upstream side.

## Intake status (orchestrator completed)

- [x] **1 Code search:** Done. The existing branch you're sitting on already contains the implementation: `cli/src/codex/utils/codexUsage.ts`, integration into `codexRemoteLauncher.ts` + `codexLocalLauncher.ts`, hub session metadata patches, web composer usage ring + popover. Diverges from `upstream/main` in 25+ files (mostly Codex flavor + a few hub session/RPC plumbing files).
- [x] **2 Upstream search:** Done. PR #537 is the only relevant prior art. Stale 6 weeks. Conflicts with current main (179 commits ahead of branch base).
- [x] **3 Playback:** Operator confirmed 2026-06-08 19:37 BST.
- [x] **4 Issue / PR:** PR #537 already open; umbrella issue [#846](https://github.com/tiann/hapi/issues/846) provides cross-flavor context. **You don't file anything new.**
- [x] **5 Demo topology:** soup. After gates pass, this lands in `~/.config/hapi/driver-manifest.yaml` and rebuilds `:3006`.

## Your assignment (feature peer)

**Own (in order):**
1. Rebase `feat/codex-usage-indicator-rebased` (currently `d54f896d`, dsus4wang's tip) onto current `upstream/main` (`66ba3121` or newer; refetch `upstream` before starting).
2. Resolve all conflicts. There are 3 original commits to replay against 179 commits of drift - expect real work.
3. Run gates per `docs/tooling/new-feature-intake.md` §6 (typecheck, tests, cold review, Playwright smoke).
4. Add manifest layer: edit `~/.config/hapi/driver-manifest.yaml` to include `feat/codex-usage-indicator-rebased`.
5. Rebuild driver: `hapi-driver-rebuild --build-web --verify`.
6. Report back to orchestrator with: demo URL, screenshot path, test output, diff stat, brief notes on any non-obvious conflict resolutions.

**Do NOT:**
- Push to `dsus4wang/*` or `origin` or `upstream` (anything visible upstream) - the orchestrator owns timing on that per the constraint above.
- Comment on PR #537, file a new PR, or contact @dsus4wang or @tiann.
- Re-architect the design. Ethan Wang's shape (`session.metadata.codexUsage` + SSE patches + composer ring) is what we want. If a conflict forces a structural choice, prefer their shape; if ambiguity remains, note it in the report and orchestrator will decide whether to escalate to the cross-flavor `agentUsage` shape from #846 (right now: don't pre-emptively refactor for that umbrella; keep this PR landable as-is, generalisation comes later).
- Run `hapi-watch-activate-driver` from your peer turn (counts your session as WORKING until your turn ends; operator runs watch externally or sets `HAPI_STACK_SWITCH_YES=1`).
- Run `hapi-use-driver` to swing live traffic - that's an operator action; you report ready, operator swings.

---

## The work

### Phase 1 - Rebase

```bash
cd ~/coding/hapi/worktrees/codex-usage-rebased
git fetch upstream
git rebase upstream/main
```

3 commits to replay. Conflicts will land on the Codex-flavor source files. Resolve preferring the *intent* of the original (capture `token_count` events, store on `session.metadata.codexUsage`, broadcast via SSE) over the literal lines (file structure has drifted in 6 weeks).

Verify after each conflict-resolved commit:
```bash
bun typecheck
bun run test
```

If a single commit's conflicts are massive (>50% of files), consider squashing during rebase (`git rebase -i upstream/main`, `squash` the second and third commits into the first). Don't lose the original authorship - keep `Ethan Wang <wangfengming@lycoretech.com>` as the `Author:` and add yourself as `Co-authored-by: <agent commit identity>` on the resulting commit message.

### Phase 2 - Gates (§6 of new-feature-intake.md)

| Gate | Command | Required pass |
|---|---|---|
| Typecheck | `bun typecheck` (root) | Yes |
| CLI tests | `bun run test` (root) | Yes |
| Web tests | `cd web && bun run test` | Yes (PR touches `web/src/components/AssistantChat/codexUsageDisplay.test.ts`) |
| Shared tests | `cd shared && bun test src/codexUsageSchema.test.ts` | Yes (PR adds schema test there) |
| Cold review | Self-review full diff vs `upstream/main` against `docs/tooling/cold-pr-review-rubric.md` | Fix Blocker/Major before reporting ready |
| Playwright smoke | See below | Yes |

#### Playwright smoke

```bash
export PLAYWRIGHT_CHROME_PATH=/usr/bin/google-chrome
node scripts/dev/read-hapi-web.mjs \
  "https://hapi.tail9944ee.ts.net/sessions/<a-codex-session-id>?token=<token>" \
  --expect "codex-usage-ring"   # or whatever class/data-attr the ring exposes
  --screenshot localdocs/playwright-runs/537-codex-usage-rebased.png \
  --timeout 30000
```

Assert: usage ring visible beside send button on a Codex session, popover shows context-window/rate-limit/token data when triggered. No `QuotaExceededError` / error-boundary strings in console.

You may need to spin a real Codex session first (`hapi codex --yolo` against a small repo) to have data to render against. Reuse an existing operator session if one is available - check with `hapi-ping-peer --list`.

### Phase 3 - Soup manifest

Edit `~/.config/hapi/driver-manifest.yaml`:

```yaml
# add to the appropriate section (look at sibling entries for shape - usually under feature_layers or similar)
- branch: feat/codex-usage-indicator-rebased
  worktree: ~/coding/hapi/worktrees/codex-usage-rebased
  note: "tiann/hapi#537 (dsus4wang) rebased onto upstream/main; awaiting author response before maintainer-edit push (timer 2026-06-15)"
```

Then:

```bash
hapi-driver-rebuild --build-web --verify
```

DO NOT run `hapi-use-driver`. Report ready; operator swings.

If the rebuild fails, that's a Blocker - report immediately with the error tail. Do not try to massage the manifest if the issue is in the feature code itself.

### DB schema

PR #537 *probably* doesn't bump `SCHEMA_VERSION` (it's metadata-on-session, not a new table), but **verify**: `rg 'SCHEMA_VERSION' hub/src/store/index.ts` against your diff. If your rebased branch introduces a `migrateFromVxToVy()` step, you MUST also add the reverse SQL to `apply_downgrade_step()` in `scripts/tooling/hapi-driver-db-prep.sh`. See `docs/tooling/driver-soup.md` "DB schema jiu-jitsu."

---

## Reporting back to orchestrator

Two checkpoints:

1. **After Phase 1 (rebase complete, gates pre-soup):** ping with `git diff --stat upstream/main...HEAD`, conflict-resolution notes, gate pass/fail summary. Stop here for orchestrator ack if anything substantive came up in conflict resolution.
2. **After Phase 3 (soup ready, all gates green):** ping with demo URL, screenshot path, what to click, full test tail. This is where operator dogfood begins.

Use `hapi-ping-peer <orchestrator-session-id> "<message>"` to send these back. Orchestrator session id: see "Parent" above.

## Stop conditions (ping orchestrator, do not push through)

- Conflict resolution requires a structural design choice you're uncertain about (which shape to pick, which file to keep).
- Tests fail in ways that look like genuine bugs in the rebased code, not just trivial fixes.
- DB schema bump appears unavoidable - flag for orchestrator before committing.
- `hapi-driver-rebuild` fails in a way you can't trace to your branch.
- @dsus4wang or @tiann posts on the PR while you're working - read it, summarise to orchestrator, stop pending guidance.

## Pointers

- **Fork canon:** `docs/operator/AGENTS.md` - includes new "Upstream collaborator status" section explaining what we self-permit on tiann/hapi while awaiting guidance.
- **Intake protocol:** `docs/tooling/new-feature-intake.md`
- **Soup mechanics:** `docs/tooling/driver-soup.md`
- **Stash policy:** `.cursor/rules/no-stash-others-work.mdc` - this is a multi-agent repo; do not `git stash` blindly.
- **Worktree layout rule:** `.cursor/rules/worktree-layout.mdc`
- **Cold review rubric:** `docs/tooling/cold-pr-review-rubric.md`
- **Local plan (cross-flavor context):** `docs/plans/2026-05-31-cursor-quota-surface-and-auto-fallback.md` Fix 6 section
- **Umbrella issue:** [tiann/hapi#846](https://github.com/tiann/hapi/issues/846)
- **The PR you're shadowing:** [tiann/hapi#537](https://github.com/tiann/hapi/pull/537)

## One more thing - Cursor flavor specific

You're running as Cursor with auto model + yolo. That means:
- You won't be asked to confirm ordinary file ops, shell commands, etc.
- Auto model means quota-conservative routing; if Cursor decides to throttle mid-task, you may notice slower responses. Don't panic; press through.
- If you hit "You're out of usage. Switch to Auto..." stderr - well, you're already on Auto. Report to orchestrator immediately; that's a hard stop.
- AskQuestion is broken in Cursor headless mode per upstream #784 (it fabricates "Questions skipped by the user" responses) - avoid AskQuestion entirely; if you need an answer, ping orchestrator via `hapi-ping-peer` instead.
