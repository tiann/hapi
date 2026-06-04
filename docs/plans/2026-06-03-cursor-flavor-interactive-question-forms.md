# Plan: cursor-flavor agents can't ask the operator a question (interactive form gap)

**Status:** open, exploratory - needs operator/peer to take it
**Filed:** 2026-06-03 00:55 BST
**Owner:** any soup-aware HAPI agent willing to dig into cursor-agent CLI internals
**Scope:** local fork primarily; the cursor-agent-side fix is upstream-against-cursor (not HAPI). HAPI-side fix is a workaround.
**Related:**
- `docs/plans/2026-05-31-cursor-quota-surface-and-auto-fallback.md` (Cursor flavor's silent-failure neighbour)
- Commit `212ce0e` (operator restart-discipline rule - same kind of "agent doesn't know how to behave well" pattern)
- Upstream PRs `#339` (MERGED 2026-03-22 - markdown rendering of question text/options) and `#579` (MERGED 2026-05-06 - claude-code 2.x answer-shape match)

---

## Problem

A HAPI cursor-flavor agent that wants to ask the operator a structured "pick A, B, or C" question has **no way to render an interactive form** in the web UI. The operator sees prose; agents fall back to markdown tables. Meanwhile HAPI's web UI is fully equipped to render interactive question forms - the renderer just doesn't get fed.

### Evidence

`~/.hapi/hapi.db`, message scan for **real** tool-call emissions of `AskUserQuestion` (the cursor-agent / claude-code native question tool that HAPI's web UI knows how to render):

```sql
SELECT json_extract(s.metadata,'$.flavor'), count(*)
FROM messages m JOIN sessions s ON m.session_id=s.id
WHERE m.content LIKE '%"name":"AskUserQuestion"%'
   OR m.content LIKE '%"toolName":"AskUserQuestion"%'
GROUP BY 1;
-- result: 0 rows
```

**Zero emissions** across 30+ agents of dogfood density covering both `cursor` and `claude` flavors. The `AskUserQuestionView.tsx` renderer is unused on the wire.

### Why

Three layers, three different reasons no form ever renders:

1. **Cursor SDK side (the orchestrator agent's tool inventory)**
 The Cursor SDK exposes `AskQuestion` (no "User") to the orchestrator agent's system prompt. That tool is intercepted by the Cursor IDE / SDK layer; in headless `cursor-agent -p ... --output-format stream-json` mode (which is what HAPI spawns), it does not emit a tool-call event onto stdout. So nothing reaches HAPI's wire.
 - Verified: `~/.hapi/hapi.db` has zero rows with `"name":"AskQuestion"` (no User) ever.

2. **cursor-agent CLI side (the model running inside cursor-agent)**
 The model running under cursor-agent CLI does not appear to have `AskUserQuestion` as an exposed tool. Even though HAPI's web UI is ready to render `AskUserQuestion`, the cursor-agent LLM has no knob to call it.
 - Verified: zero cursor-flavor emissions of `AskUserQuestion` in the messages table after filtering text mentions.

3. **Claude-code CLI side (where AskUserQuestion is real)**
 Claude Code 2.x's LLM does have `AskUserQuestion`. But HAPI's `cli/src/claude/utils/permissionHandler.ts` lines 229-238 intercepts the tool call as a *permission request*, resolves it through the `RequestUserInput` flow, and never stores it as a `"name":"AskUserQuestion"` row in the messages table. So the question form does render on the web side via the permission/RequestUserInput surface, but **only for claude-flavor sessions**, and the wire shape is permission-flavoured rather than a regular tool-call.

Result: HAPI has the rendering machinery in place, but for **cursor-flavor**, no path emits the right shape into the wire.

### What HAPI already has (do not rebuild)

| Asset | Path |
|-------|------|
| Renderer | `web/src/components/ToolCard/views/AskUserQuestionView.tsx` |
| Footer with single/multi options + custom-answer input | `web/src/components/ToolCard/AskUserQuestionFooter.tsx` |
| Schema parser | `web/src/components/ToolCard/askUserQuestion.ts` |
| Permission-flow handler (claude-code) | `cli/src/claude/utils/permissionHandler.ts` lines 37-122, 229-238 |
| Locale strings | `web/src/lib/locales/en.ts`, `zh-CN.ts` (`tool.askUserQuestion.fallback`, `.placeholder`, `.otherPlaceholder`) |
| Upstream PRs landed | `#339` (markdown render), `#579` (claude-code 2.x answer-shape match) |

The render-side is solved. The wire-side, for cursor flavor, is not.

---

## Three options, ordered by cost

### Option 1 - DO (cheapest, fork-local) - Operator/agent-rule clarification

Add a one-paragraph rule to `docs/operator/AGENTS.md` and `.cursor/rules/operator-fork.mdc` so agents stop trying to call SDK `AskQuestion` (which silently disappears) and use markdown tables when interactive ask is needed in HAPI context.

**Why this isn't really a fix but is worth doing:** today every cursor-flavor agent in HAPI that "thinks" it asked an interactive question actually rendered nothing. Documenting the failure mode prevents the "AskQuestion form must have eaten itself" rationalisation pattern (see this fork's chat scrollback) and explicitly steers agents to a working alternative.

**Cost:** 4 lines of docs. Stack on top of the hub-restart discipline rule already added in commit `e8973f4`.

### Option 2 - DO (medium, HAPI-fork-local) - Markdown convention rendered as a form

Have HAPI's web UI parse a documented markdown convention in agent message bodies (e.g.):

```markdown
<!-- ask: single -->
**Where should we deploy?**

- [ ] **A — staging** — current default
- [ ] **B — production** — needs operator confirmation
- [ ] **C — neither, hold** — no work
```

The web UI's `MarkdownRenderer` (already present) detects the `<!-- ask: single -->` or `<!-- ask: multi -->` comment and re-renders the bullet list as an interactive radio/checkbox form. The operator clicks; the form submits a regular user-message body (`"selected: B — production"`) back through the existing message-send path. No new wire shape; no agent-side tool change; no cursor-agent CLI cooperation needed.

**Why this works:** every flavor that emits markdown reaches the same renderer. Cursor flavor, claude flavor, codex, gemini - all benefit immediately. The convention is opt-in (no `<!-- ask: ... -->` comment ⇒ plain prose, current behaviour). Agents pick it up via a system prompt addition.

**Cost:**
- 1 new web component: `web/src/components/AskFormFromMarkdown.tsx` (~150 LOC)
- 1 markdown-renderer hook to detect the comment: `web/src/components/MarkdownRenderer/extensions/askForm.ts` (~80 LOC)
- 1 doc page: `docs/operator/agent-conventions.md` adding the convention
- 0 cursor-agent CLI changes; 0 protocol/schema changes; 0 hub changes
- Tests: render with single and multi modes, click to send, fallback when comment is malformed (degrade to plain markdown).

**Risks:**
- Convention drift across flavors (each agent's system prompt has to know the comment shape). Mitigation: add to `.cursor/rules/operator-fork.mdc` (alwaysApply) and equivalent in claude/codex configs as fork-local additions.
- Markdown-injection if a model emits `<!-- ask: ... -->` accidentally. Mitigation: strict parser that requires the comment to be at the top of the message and the bullet list to immediately follow.

### Option 3 - WON'T DO (or deferred upstream) - Make cursor-agent CLI expose AskUserQuestion

The "right" fix is in cursor-agent itself: expose `AskUserQuestion` (or equivalent) to the LLM running headlessly so it can emit a real tool-call onto stream-json. HAPI's renderer would pick it up immediately - PR `#579` already wired the answer-shape match.

**Why won't-do here:**
1. cursor-agent CLI is a different repo (`cursor-agent` upstream is part of Cursor's own product, not in `tiann/hapi`). Filing this against HAPI doesn't reach the right maintainer.
2. The change has unbounded scope from this fork's perspective (depends on Cursor's tool-exposure roadmap).
3. Option 2 gets the operator the same end-state (interactive form on cursor flavor) without crossing org boundaries.

If a Cursor-side maintainer ever does expose `AskUserQuestion` headlessly, HAPI's existing renderer takes over with no further fork work. This option is **deferred indefinitely**, not actively pursued.

---

## Recommended order

1. **Option 1 right now** (4-line docs change). Costs nothing, prevents the rationalisation pattern from compounding.
2. **Option 2 as a soup-stack feature** when an agent picks it up. ~250 LOC, fork-local, no protocol churn.
3. **Option 3** as a watching brief - if Cursor exposes the tool headlessly, retire Option 2's convention.

---

## Upstream-fitness

| Option | Local-only or upstream-PR? |
|--------|----------------------------|
| **Option 1** | **Local only.** Operator-fork doc rule. Not relevant upstream. |
| **Option 2** | **Could go upstream** if maintainer is receptive - the markdown-comment convention benefits any HAPI user with a flavor that doesn't emit `AskUserQuestion`. Reasonable PR. Carry locally first; PR opportunistically. |
| **Option 3** | **Out-of-scope** for HAPI; would be a Cursor-side change. |

---

## Verification matrix (for Option 2 if it ships)

| Scenario | Before | After |
|----------|--------|-------|
| Cursor agent emits prose with `<!-- ask: single -->` | Renders as plain markdown bullets | Renders as radio-button form; click sends back `"selected: <option>"` |
| Cursor agent emits prose without the comment | Plain markdown bullets | Same plain markdown bullets (no regression) |
| Claude agent calls native `AskUserQuestion` | Renders via permission-flow already | No change; permission flow stays primary for claude |
| Malformed comment (`<!-- ask: -->` no mode) | n/a | Falls back to plain markdown; warning in dev console |
| Multiple `<!-- ask: ... -->` blocks in one message | n/a | All render as separate forms; each submits independently |

---

## Friction-mode notes

**Steelman of "do nothing":** Markdown tables work fine. Operators can read prose, type their answer. Interactive forms are nice-to-have. Counter: the "AskQuestion form must have eaten itself" pattern is real - agents waste turns thinking they've asked the operator something when they haven't, then sit silent waiting for an answer that never comes. That's an integrity-of-action problem, not a UX-polish problem.

**Steelman of "fix cursor-agent upstream":** The Right Answer is for cursor-agent to expose AskUserQuestion headlessly. Anything HAPI-side is a workaround. Counter: HAPI is the surface the operator sees; waiting for a Cursor-side roadmap change is unbounded. Carry the workaround until Cursor catches up; retire it then.

**Cheapest falsification:** sample 5 cursor-flavor agent transcripts from the last 7 days. If none of them attempted to ask the operator a structured question (i.e. always emitted plain prose with no "Which would you like?" pattern), then the gap doesn't bind anyone today and Option 2 is overkill. If 2+ did, Option 2 earns its keep.

---

## Definition of done

**Option 1 done when:**
- `.cursor/rules/operator-fork.mdc` and `docs/operator/AGENTS.md` both contain a "Tools available to agents in HAPI" note distinguishing `AskQuestion` (Cursor SDK, doesn't traverse) from `AskUserQuestion` (cursor-agent / claude-code native, renders for claude flavor only) and recommending markdown tables as the working alternative for cursor flavor.

**Option 2 done when:**
- `<!-- ask: single -->` and `<!-- ask: multi -->` markdown comments render as interactive forms in `web/src/components/MarkdownRenderer`.
- Clicking submits a regular user-message body back through the existing message path.
- Tests cover render, submit, malformed, multi-block scenarios.
- `docs/operator/agent-conventions.md` documents the convention; alwaysApply rule in `.cursor/rules/operator-fork.mdc` references it so agents pick it up automatically.
- Soup-manifest entry: `feat/cursor-flavor-ask-form-markdown`.
- Verification matrix executed; logs captured under `~/coding/hapi/localdocs/operator/`.

**Option 3:** marked "deferred / watching brief"; no work unless Cursor announces headless tool exposure.
