# Peer briefing — #829 mermaid parse-failure agent feedback (Approach B)

**Branch:** `feat/mermaid-parse-failure-feedback`
**Worktree:** `~/coding/hapi/worktrees/mermaid-feedback/`
**Base:** `upstream/main` @ `66ba3121` (`fix(web): suppress Mermaid render error SVGs (#813)`)
**Demo topology:** **soup** — operator wants this on `:3006` daily driver after gates pass
**Tracker:** [tiann/hapi#829](https://github.com/tiann/hapi/issues/829)

---

## Parent

- Orchestrator Cursor session: `d1ceebab-27db-4601-9b9d-00a5c5bc7c3f`
- Operator request: "scope an issue [for the lack of agent feedback when mermaid charts fail to parse client-side]" → issue filed → operator picked **Approach B** + **soup**

## Intake status (orchestrator completed)

- [x] **1 Code search:** Done. Web render is `web/src/components/assistant-ui/mermaid-diagram.tsx` (parse-then-render gate, suppressErrorRendering, fallback to raw `<pre><code>`). Hub stores markdown verbatim, no mermaid awareness. CLI doesn't validate. No render-issue endpoint, no `system`-channel injection precedent under that name (`rg -n 'systemNote|renderIssue|render_issue' --type ts shared/ hub/src cli/src` → empty).
- [x] **2 Upstream search:** Done. Adjacent: #785 (closed, mermaid crash → hardening this depends on), #737 (open lightbox issue), #741 (open lightbox PR), #813 (merged 2026-06-06, suppress render error SVGs — already at base). No prior issue/PR covers the agent-feedback gap. New ground.
- [x] **3 Playback:** Done. Operator confirmed approach + topology on 2026-06-07 01:48 BST.
- [x] **4 Issue:** [#829](https://github.com/tiann/hapi/issues/829) — open, contains the full A/B/C proposal. **You implement Approach B only.**
- [x] **5 Demo topology:** soup. After gates pass, briefing back to orchestrator includes manifest-layer add + `hapi-driver-rebuild` + `hapi-use-driver` checklist.

## Your assignment (feature peer)

**Own:** implementation → unit/integration tests → Playwright smoke → fork-stage cold review → upstream PR → babysit until merged.
**Do NOT redo:** issue filing, worktree creation, upstream search.
**Do NOT** edit `~/coding/hapi/driver` by hand. **Do NOT** touch fork-only paths in this branch (see "Upstream file boundaries" below).

---

## The feature (Approach B from the issue)

Wire a one-shot client → hub → CLI signal so the agent learns when its emitted mermaid block failed to parse / render in the user's browser, and can self-correct on the next turn.

Today: `MermaidDiagram` sets local `renderError` state, falls back to `<pre><code>`. Nothing leaves the component. Hub doesn't know. CLI doesn't know. Agent emits more broken charts.

After: when a mermaid block fails parse OR render in at least one client, exactly one structured signal reaches the agent transcript per `(sessionId, messageId, codeHash)` so it doesn't thrash on N PWAs rendering the same broken chart.

### Surfaces (in expected dependency order)

1. **`shared/src/schemas.ts`** — new `RenderIssueReportSchema` (sessionId, messageId, kind=`'mermaid_parse_failure' | 'mermaid_render_failure'`, codeSnippet (truncated, e.g. ≤ 500 chars), parserVersion, errorMessage?). Reuse existing schema style.
2. **`hub/src/web/routes/sessions.ts`** (or new `renderIssues.ts`) — `POST /api/sessions/:id/render-issues`. Validate. Dedupe per (messageId, codeHash). Persist a row (decide: new table, or column on `messages`, or in-memory if churn risk).
3. **`hub/src/store/`** — schema bump if you add a table. If you bump `SCHEMA_VERSION`, **mandatory** downgrade SQL in `scripts/tooling/hapi-driver-db-prep.sh apply_downgrade_step()` (see `docs/tooling/driver-soup.md` "DB schema jiu-jitsu"). Skip the bump if you can avoid persistence (e.g. ephemeral in-memory dedupe + immediate forward to CLI).
4. **`hub/src/socket/handlers/cli/`** + **`shared/src/socket.ts`** — new socket event from hub → CLI: `render-issue-reported`. Payload = the validated report.
5. **CLI consumer** — on receiving `render-issue-reported`, queue a single low-noise system-channel turn into the agent transcript on the next agent prompt. Suggested copy (tune to match existing CLI tone, look for prior precedent in `cli/src/claude/`, `cli/src/codex/`, `cli/src/cursor/`):

   > A previous mermaid block in your response did not render in the user's browser (`<kind>`):
   > ```
   > <truncated code snippet>
   > ```
   > The user saw it as raw text. If the diagram was intended, please re-emit with corrected syntax.

   Pick an injection seam that already exists; do **not** invent a new transcript channel if a `system`/`user-system`/MCP-style hint already works. If unclear, file a sub-question in the PR description rather than guessing.
6. **`web/src/components/assistant-ui/mermaid-diagram.tsx`** — in both fail branches (`!isValid` and the `catch`), post the report to the new endpoint **at most once per `(messageId, codeHash)` within the browser tab** (use a `WeakMap` or `Set` keyed on `${messageId}:${hash(code)}`). Wrap in try/catch + `void` to never break the existing graceful fallback. Use the existing fetch/api client wrapper (look in `web/src/api/`).
7. **(Optional, ask in PR if time)** small "diagram could not be rendered — agent has been notified" pill below the fallback so the user knows the loop closed. **Optional.** If it adds > 30 LOC, defer to a follow-up issue.

### Plumbing notes

- `messageId` must be the **assistant message id** that contained the mermaid block, not a per-render id. `mermaid-diagram.tsx` doesn't currently know its parent message. You'll need to pass it down via the markdown renderer chain. Check `web/src/components/AssistantChat/messages/` for the message context. If passing is invasive, fall back to `null` and dedupe on `codeHash` alone for v1; flag the limitation in the PR.
- Dedupe: SHA-256 of the code string is overkill; `cyrb53` or even `code.length + first/last 20 chars` is fine. We just don't want N PWAs each posting the same failure.
- `parserVersion`: pull from `import('mermaid').then(m => m.default.version)` at report time. Helps reproduce server-side if maintainers ever want a hub-side validator.

## Acceptance criteria (lifted from the issue, restated)

- [ ] Agent receives one structured signal per `(messageId, codeHash)` when a mermaid block fails parse or render in any connected client.
- [ ] N PWAs rendering the same broken chart do not produce N signals to the agent.
- [ ] User-visible fallback (raw `<pre><code>`) unchanged.
- [ ] `securityLevel: 'strict'` and `suppressErrorRendering: true` stay in place.
- [ ] No XSS surface: `codeSnippet` server-side is treated as untrusted; truncated; never injected as HTML.
- [ ] Works for all CLI flavors that emit assistant text (claude, codex, cursor-acp, cursor-legacy, opencode, gemini) — at minimum claude + cursor-acp wired and tested; others gracefully no-op without errors if the seam doesn't apply.
- [ ] Pre-existing tests still green.
- [ ] New tests cover: schema validation, dedupe by `(messageId, codeHash)`, route returning 4xx on garbage, route returning 2xx on valid.

## Gates before reporting back to orchestrator (mandatory — see `docs/tooling/new-feature-intake.md` §6)

1. `bun typecheck` (root) and `bun run test` (root + `cd web && bun run test` if web touched)
2. `bun run lint` if the repo runs it pre-PR
3. **Cold code review** of full diff vs `upstream/main` using `docs/tooling/cold-pr-review-rubric.md`. Fix Blocker/Major before handoff. Skill: `~/.claude/skills/receiving-code-review/SKILL.md` for discipline on revisions.
4. **DB schema:** if you bumped `SCHEMA_VERSION` in `hub/src/store/index.ts`, the matching downgrade SQL in `scripts/tooling/hapi-driver-db-prep.sh apply_downgrade_step()` **must** be in the same commit. Verify by running `hapi-driver-db-prep --dry-run` (or rebuild). Without this, swinging `hapi-active` off this layer later aborts cleanly but blocks.
5. **Playwright smoke** — real browser, real broken mermaid block, real assertion that:
   - User sees raw fallback
   - POST to `/api/sessions/:id/render-issues` happens exactly once (network panel)
   - A second tab on the same session does NOT fire a second POST (dedupe holds across the same client; cross-client dedupe is hub-side)
   - System-channel hint appears in the agent transcript on the next turn (or in the CLI log if no transcript record)
   ```bash
   export PLAYWRIGHT_CHROME_PATH=/usr/bin/google-chrome
   node scripts/dev/read-hapi-web.mjs \
     "https://hapi.tail9944ee.ts.net/sessions/<demo-session-id>?token=<token>" \
     --expect "aui-mermaid-fallback" \
     --screenshot localdocs/playwright-runs/829-mermaid-feedback.png \
     --timeout 30000
   ```
   If you need a feature-specific repro script, add it under `scripts/dev/829-mermaid-feedback-playwright.mjs`.

**Do not** ping the orchestrator with "please try it" until (1)–(5) all pass.

## Soup deployment checklist (after operator dogfood approval)

1. Add layer to `~/.config/hapi/driver-manifest.yaml` (form: `- branch: feat/mermaid-parse-failure-feedback` under the appropriate section — look at existing entries for shape).
2. `hapi-driver-rebuild --build-web --verify`
3. `hapi-use-driver` (operator runs from their own shell or you set `HAPI_STACK_SWITCH_YES=1` per intake §5; **do not** run `hapi-watch-activate-driver` from this peer turn).

## Upstream PR voice and discipline

- Body: humble first-timer; clean Summary / Problem / Approach / Testing / Related / Questions sections.
- **AI disclosure block is mandatory.** Example: `## Disclosure\n\nThis PR was developed with assistance from Claude Sonnet 4.6 (claude-4.6-sonnet) acting as a peer agent in a multi-agent workflow.` Match whatever model you actually use; if you mix models, list all. Policy is in upstream `CONTRIBUTING.md` and fork's `AGENTS.local.md`.
- Body must contain `Closes #829` (or `Fixes #829`).
- **Never** in the PR body or commit messages: persona names, fork strategy, operator-internal plans, persona quotes, internal session ids, tailnet URLs.
- **Never** in the diff: `AGENTS.md` (root), `CONTRIBUTING.md`, `docs/operator/*`, `docs/plans/*`, `localdocs/`, `.cursor/rules/operator-fork.mdc`, `AGENTS.local.md`.

### Pre-PR sanity check (run before `hapi-pr-create`)

```bash
git fetch upstream
git diff --name-only upstream/main...HEAD | grep -E '^(AGENTS\.md|CONTRIBUTING|docs/operator|docs/plans|localdocs|\.cursor/rules/operator)' && echo STOP || echo OK
```

### Fork-stage cold-review (MANDATORY before upstream PR)

This is the non-skippable gate added 2026-06 to ensure every upstream PR is bot-clean on first review:

```bash
git push -u origin feat/mermaid-parse-failure-feedback
gh pr create --repo heavygee/hapi --base main --head feat/mermaid-parse-failure-feedback --draft \
  --title "feat(web+hub+cli): mermaid parse-failure agent feedback [fork stage]" \
  --body-file body.md  # same body planned for upstream
# wait for fork review bot, address findings, iterate
gh pr edit <fork-pr-number> --add-label cold-review-clean
gh pr close <fork-pr-number>
```

Then open the upstream PR:

```bash
hapi-pr-create \
  --title "feat(web+hub+cli): surface mermaid parse failures back to the agent (#829)" \
  --body-file body.md
```

`hapi-pr-create` enforces: base=`upstream/main`, `check-operator-leaks.sh` on diff + body, `Closes #N` keyword present. Don't bypass with `--no-closes-required` here — #829 is the tracker.

### After upstream PR opens

Follow `docs/tooling/pr-review-loop.md`. Apply skill: `~/.claude/skills/babysit/SKILL.md` to keep merge-ready while review iterates.

## Reporting back to orchestrator

When gates (1)–(5) pass, ping orchestrator with:

- Soup activation status (manifest edited? rebuild output? swing done?)
- Demo URL (tailnet `https://hapi.tail9944ee.ts.net/sessions/...` + LAN if applicable)
- What to click in the demo (specific broken mermaid block to trigger the path)
- Screenshot path (`localdocs/playwright-runs/829-mermaid-feedback.png`)
- `git diff --stat upstream/main...HEAD` output
- Cold review summary (Blocker/Major counts: 0/0 required to proceed)
- Test output tail

Orchestrator will get operator dogfood approval before you proceed to fork-stage cold review.

## Stop conditions (ping orchestrator, do not push through)

- Cold review surfaces a Blocker you can't resolve cleanly.
- Playwright smoke can't be made reliable (flaky dedupe, real broken chart hard to inject).
- The "pass messageId down to mermaid-diagram" plumbing turns out to require a refactor larger than ~150 LOC — propose splitting into a prior refactor PR.
- A `SCHEMA_VERSION` bump becomes necessary AND the downgrade SQL isn't obvious — request review before committing.
- Any signal that upstream already has work in flight on this (recheck `gh search` open + closed before you push).

## Pointers

- **Fork canon:** `docs/operator/AGENTS.md`
- **Intake protocol:** `docs/tooling/new-feature-intake.md`
- **Worktree layout rule:** `.cursor/rules/worktree-layout.mdc`
- **Soup mechanics:** `docs/tooling/driver-soup.md`
- **PR review loop:** `docs/tooling/pr-review-loop.md`
- **Cold review rubric:** `docs/tooling/cold-pr-review-rubric.md`
- **No-stash policy:** `.cursor/rules/no-stash-others-work.mdc` — this repo has multi-agent dirty trees; do not `git stash` blindly. If your worktree is clean (it should be — it's brand new), this doesn't bite you, but be aware before any rebase.
- **Issue body (full proposal A/B/C):** [tiann/hapi#829](https://github.com/tiann/hapi/issues/829)
