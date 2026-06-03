# Peer handoff: turn the Rev 4 Overseer architecture into a local-fork issue tree

> **Target peer:** fresh Claude Opus session, YOLO mode, no prior context on this thread.
> **Spawned by:** hapi operator agent (this thread).
> **Date:** 2026-06-03
> **Estimated effort:** 1-2 hours (read docs, decompose, file issues, summarize).

---

## §0 Handoff intake block (read this first)

**Operator's intent (done):**

- A coherent multi-doc architecture for the HAPI fleet attention-arbitration layer ("Overseer") exists and was just committed on 2026-06-03.
- Five files form the canonical spec:
  - `docs/plans/2026-06-03-overseer-framing.md` (concept, model, decision channel)
  - `docs/plans/2026-06-03-overseer-contracts.md` (schemas + 12 implementation contracts)
  - `docs/plans/2026-06-03-overseer-prioritization.md` (scoring loop, replay harness, attention budget, prior art)
  - `docs/plans/2026-06-03-overseer-build-sequence.md` (Steps 1-6+, MVP acceptance bar, risks by phase, PR slicing)
  - `docs/adr/0001-worker-facing-attribution-one-boss.md` (one-boss principle ADR)
- The doc set is final. Do NOT modify it. Do NOT propose Rev 5 revisions.

**Your job (owned):**

- Read all five docs end-to-end. Treat the build-sequence doc as your primary spec; the others are reference.
- Decompose the build sequence into a set of trackable GitHub issues on **the local fork (`heavygee/hapi`)**, NOT on upstream (`tiann/hapi`).
- File issues per the strategy in §3 below. Use `gh issue create --repo heavygee/hapi`.
- Cross-link issues so the dependency graph is navigable from any node.
- Report back with a list of issue numbers + a one-line rationale per issue + the dependency graph.

**Explicitly NOT your job:**

- Do NOT start implementation work on any step.
- Do NOT modify any source code in the repo.
- Do NOT modify the 5 architecture docs.
- Do NOT push commits.
- Do NOT open pull requests.
- Do NOT spawn other peer agents.
- Do NOT file issues on `tiann/hapi` (upstream) under any circumstance.

---

## §1 The candid backstory the public docs do not carry

> **This section is operator-private context for YOUR understanding only.** The 5 architecture docs were sanitized before commit to remove all of this framing. Issue bodies you create MUST use the sanitized vocabulary from the public docs - never the candid framing below.

### Why the docs were sanitized

The doc set went through a deliberate scrub before commit. Earlier revisions used "stealth," "cover story," "first reveal," "deployment-by-stealth," and "reveals nothing strategic" throughout. The operator pointed out that the public fork (`heavygee/hapi`) is browsable, and while nobody is actively watching, an accidental reader stumbling onto spy-thriller vocabulary would read it as deceptive even though the actual practice (dependency-first phased rollout) is bog-standard product engineering.

The scrub replaced all loaded vocabulary with neutral product-rollout words. Substance unchanged. Optics normal. **Issue bodies you write MUST stay in the sanitized register.** "Phased rollout," "dependency-first sequencing," "low-risk first PR," "substrate-before-surface" - good. "Stealth," "cover story," "reveal," "first surface of the architecture" - bad.

### Why this matters beyond optics

This is the largest single architectural commitment HAPI has made. The operator is attempting to land a fleet-level conversational agent on top of HAPI's existing per-session worker model. That is a fundamental change to what HAPI is *for*. Today HAPI is a multi-session agent orchestrator; the Overseer layer makes it a fleet attention-arbitration system with a real-time decision channel.

**Best-case outcome:** the upstream maintainer (tiann) sees each phase land as a standalone-useful PR, accepts them incrementally, and the fork eventually merges back into upstream as the Overseer becomes part of HAPI proper.

**Worst-case outcome:** upstream rejects the architectural direction, and the operator forks off permanently with a meaningfully different HAPI. This outcome is **what we are trying to avoid.**

The "phased rollout" framing in the public docs is genuine engineering reasoning (substrate before surface so day-one works), AND it is the right shape for upstream-friendly contribution: each phase has standalone value, each phase ships small, each phase is reviewable on its own merits, and the architectural reveal happens late enough that earlier phases have already proven themselves. Upstream gets to opt-in incrementally, rather than face a fully-formed mega-feature with "you must accept all of this or none of it."

When you file issues, internalize this: **each issue should describe work that has standalone value to HAPI even if no subsequent step lands.** That framing is honest and it is also what gives the architecture the best chance of avoiding the permanent-fork outcome.

### Why "operator is also the daily user" matters

The operator runs this HAPI fleet daily as their primary work surface. They are simultaneously: the spec author, the implementing maintainer (often with peer agents like you), the daily user, the QA, and the only person currently exercising the multi-fleet-agent workflow at scale. Every architecture decision factors in the operator's lived experience of running 30+ parallel agent sessions.

This is also why the phased rollout exists: even if upstream isn't part of the equation, **the operator needs the substrate to prove itself under their real load before the operator-facing chrome shifts to depend on it.** A chrome-button move that breaks the operator's daily workflow is a self-inflicted wound. The phasing protects the operator from themselves as much as it protects the upstream-friendly contribution path.

### Which peers are currently in flight (do not disturb their work)

- A peer is shipping a per-session scratchlist v1 (issue #11). Architecture absorbs this at fleet level via Contract §15 "operator intent capture." The v1 work is NOT wasted - it informs the fleet-level migration. **Your issue for the §15 work should reference #11 as "absorbs the v1 per-session model at fleet level after #11 ships," not as "supersedes #11."**
- A peer is shipping a fix for the composer-eats-text-on-error bug (issue #15). Unaffected by this architecture. Do not touch.
- A peer is working on backups (issue #7). Unaffected. Do not touch.

### Public-doc vocabulary discipline reminder

| Forbidden in issue bodies | Use instead |
|---|---|
| stealth / stealth rollout / stealth plan | phased rollout / dependency-first sequencing |
| cover story | (just describe what the phase delivers) |
| reveal / first reveal | (just describe what the phase delivers) |
| chrome reveal | chrome-button move |
| reveals nothing strategic | low-risk / substrate-only / quality-of-life |
| thunderclap | single big-bang change |
| Adopters self-select | (drop entirely) |

If you find yourself wanting to write any of the left-column phrases in an issue body, use the right-column substitute or just describe the work plainly.

---

## §2 Existing local-fork issue landscape

Run this first to see what's already filed:

```bash
gh issue list --repo heavygee/hapi --state open --limit 50
```

**Known umbrella-relevant issues currently open on `heavygee/hapi`:**

- **#14** - "App: project-level page with PR / issues panels + agent dispatcher (controlplane)" - this is the Overseer umbrella; absorb into Step 3 + Step 4 + Step 5 work, or update #14 to point at the new build-sequence issues you create. **Your call on which is cleaner.**
- **#18** - "Controlplane: cross-session chat search + memory layer (Claude's pattern)" - absorbed by Contract §7 (memory promotion rules) + the events table substrate (Step 2). Update #18 to reference the appropriate new issues, or close as "absorbed" with cross-reference.
- **#11** - per-session scratchlist - peer is shipping v1; do NOT close. File a separate fleet-level issue that references #11 and explains the §15 absorption.
- **#19** - channels (external sources feeding into events) - explicitly post-MVP per the build-sequence doc. File as separate post-MVP issue; do not absorb into MVP steps.

You may discover other relevant issues. Read titles, decide whether to cross-reference or absorb. When in doubt: cross-reference rather than absorb (it's reversible).

---

## §3 Issue creation strategy

### What to file (target: ~9-11 issues)

**Pre-flight (1 issue):**

1. **Emission-contract empirical sniff** - a one-evening experiment to measure how reliably the prompted event-emission contract (Contracts §1) actually gets compliance from real worker agents (Cursor / Claude / Codex). Spawn one worker per flavor with the §1 wire-format prompt baked into the system instruction, give each a small bounded task (run tests, open a PR, fix a small bug), measure emission rate and shape conformance. Output: short doc - "compliance is X%, malformed in Y way, hub-observed fallback needs to cover Z" - that recalibrates Step 2's scope and risk. **Kill-criterion:** if compliance is under ~40% even with prompt iteration, the prompted-emission contract is the wrong primitive and Steps 2-4 need a code-level emission API rewrite. This issue blocks Step 2.

**Build-sequence steps (7 issues):**

2. **Step 1** - Voice persistence + receiving-session indicator (smallest shippable PR; full scope in build-sequence doc Step 1)
3. **Step 2** - Events table + worker emission (events schema migration, prompted-emission contract, hub-observed fallback)
4. **Step 2.5** - Inbox substrate + v0 prioritizer (`inbox_items` migration, promotion job, hand-tuned base priorities, dedupe/merge, `explain_priority`)
5. **Step 2.75** - Replay harness v0 + CI gate (golden scenarios, one-boss invariant test stub)
6. **Step 3** - Read-only Overseer wired to voice (Overseer entity, 7-tool read-only set, voice route, `convo_turn` writeback)
7. **Step 4** - Disagreement-capable Overseer + voice dispatch with confirm (dispatch envelope, voice-confirmation UX, dispatch UX contract, contradiction handling). **MVP acceptance bar is met when Step 4 lands.**
8. **Step 5** - Chrome-button move + per-session button retirement (post-MVP polish; chrome voice button becomes primary)

**Umbrella (1 issue):**

9. **Overseer architecture umbrella** - either by updating existing #14 to be the umbrella for the new step issues, or by filing a fresh umbrella that cross-references #14, #18, #11, #19 with their absorption status.

**Optional absorption cross-references (0-2 issues; only if useful):**

10. Cross-link issue for #18 absorption (if updating #18 itself isn't clean enough).
11. Cross-link issue for §15 operator intent capture at fleet level (referencing #11's v1 work).

Total target: **9-11 issues.**

### Issue body template

For each step issue, use this shape (markdown):

```markdown
## Goal

One-sentence statement of what this step delivers.

## Spec

- `docs/plans/2026-06-03-overseer-build-sequence.md` Step N (primary)
- `docs/plans/2026-06-03-overseer-contracts.md` §X, §Y (relevant contracts)
- `docs/plans/2026-06-03-overseer-prioritization.md` §Z (if applicable)
- `docs/adr/0001-worker-facing-attribution-one-boss.md` (if applicable)

## Acceptance

- Bullet list from the step's "Scope" section in the build-sequence doc.
- Each bullet should be checkable - is this acceptance criterion met yes or no?

## Out of scope

- Bullets that explicitly do NOT belong in this step.
- Reference subsequent step issues for "this happens later in Step N+1."

## Dependencies

- Blocks: #issueN (issues this issue blocks)
- Blocked by: #issueN (issues this issue waits on)

## Suggested PR breakdown

From `docs/plans/2026-06-03-overseer-build-sequence.md` "PR slicing" table.
Usually 1-3 PRs per step.

## Risks

- Bullets from `docs/plans/2026-06-03-overseer-build-sequence.md` "Risks by phase" section for this step.
- Include any named failure modes that apply.

## Notes

(Optional. For anything the peer implementer should know that doesn't fit above.)
```

### Issue labels

Check what label conventions exist on `heavygee/hapi`:

```bash
gh label list --repo heavygee/hapi
```

If labels exist for `enhancement`, `infrastructure`, `controlplane`, `fleet-overseer`, `voice`, `mvp` - use them appropriately. If a `fleet-overseer` label doesn't exist, create it and apply it to all the architecture issues:

```bash
gh label create fleet-overseer --description "Fleet attention-arbitration architecture" --color "5319e7" --repo heavygee/hapi
```

Other labels you might want to create (if not present):
- `architecture` - for the umbrella + step issues
- `mvp` - for Steps 1, 2, 2.5, 2.75, 3, 4 (the MVP acceptance bar)
- `post-mvp` - for Step 5+ and the deferred channel work
- `pre-flight` - for the emission-contract sniff

### Dependency graph (for cross-linking)

```
                      [umbrella: Overseer architecture]
                                    |
              +---------------------+---------------------+
              |                                           |
   [Pre-flight: emission-contract sniff]                 (informs)
              |
              v
         [Step 2: events + emission]
              |
              v
         [Step 2.5: inbox + v0 prioritizer]
              |
              v
         [Step 2.75: replay harness + CI]
              |
              v
   +----------+---------+
   |                    |
   [Step 1: voice       [Step 3: read-only
    persistence +        Overseer + voice]
    indicator]                |
   (parallel; not             v
    blocked by 2-2.75)   [Step 4: dispatch
                          + contradiction]
                                |
                                v
                          [Step 5: chrome-button
                           + retire per-session]
```

Step 1 is intentionally parallel to Steps 2-2.75 because voice persistence is frontend/transport work that doesn't depend on the substrate. Operator can ship Step 1 anytime; Steps 2-2.75 unblock Steps 3-4 in order.

### Cross-reference discipline

- The umbrella issue references all 8 child issues (pre-flight + 7 steps).
- Each step issue references the umbrella in its body.
- Each step issue references the prior-step issue(s) it depends on AND the next-step issue(s) it unblocks.
- The pre-flight emission-contract issue explicitly states it blocks Step 2 and informs Step 2's scope.
- Absorbed-issue cross-references update the original issue (#11, #14, #18, #19) to point at the new umbrella and/or relevant step issue.

---

## §4 Acceptance criteria for your work

When you're done, you should be able to send a single summary message back containing:

- The umbrella issue number (and whether it's the existing #14 reused or a new issue).
- A numbered list of every child issue you created, with title and one-line rationale.
- The dependency graph as it exists on GitHub (issue numbers replacing the bracketed names in the §3 graph above).
- A list of any existing issues you touched (with description: "updated #18 to cross-reference new umbrella," etc.).
- One sentence on any deviation from this handoff plan that you made, with rationale.
- One sentence on anything you noticed in the docs that the handoff should have warned you about but didn't.

If you create labels that didn't exist, list them too.

If you hit any blocker (commit-msg hook, `gh` auth issue, ambiguity in the spec), STOP and report. Do not improvise around blockers; the operator is reachable and will unblock you.

---

## §5 Mechanical details

**Working directory:** `~/coding/hapi` (this directory; the active checkout)

**Branch:** `tooling/legacy-chat-attach-scripts` - this is where the architecture docs were just committed (commit `2af857a`). You should NOT need to switch branches. You are NOT writing code; you are only filing GitHub issues. Filing issues does not touch the working tree.

**GitHub auth:** `gh auth status` should show you authenticated as `heavygee`. If not, stop and report.

**Issue-creation command (do not deviate):**

```bash
gh issue create --repo heavygee/hapi \
  --title "[title]" \
  --label "fleet-overseer,architecture,mvp" \
  --body "$(cat <<'EOF'
[body using the §3 template]
EOF
)"
```

Issue bodies with backticks, code blocks, or `$` characters should always go through a heredoc to prevent shell interpretation. (Reference: `~/.claude/skills/github-cli-safety/SKILL.md` for the safety pattern.)

**Do NOT do these things:**

- Do NOT use `gh issue create --repo tiann/hapi` (that's upstream; would leak internal planning).
- Do NOT include the words "stealth," "cover story," "first reveal" in any issue body (the public-doc vocabulary scrub applies to issues too).
- Do NOT reference this handoff document (`docs/plans/peer-handoff-overseer-build-plan.md`) in any issue body - that file is operator-private and references to it shouldn't appear on the public-fork GitHub page.
- Do NOT reference the candid backstory in §1 of this handoff anywhere - it's for your context only.

**When done**, post a single summary message to this session via:

```bash
curl -X POST http://localhost:3006/api/sessions/<this-session-id>/messages \
  -H "Cookie: hapi_token=$HAPI_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(cat <<'EOF'
{
  "body": "[your summary per §4]"
}
EOF
)"
```

The session ID will be provided when you're spawned. Treat the message as a final report; the spawning thread will be watching for it.

---

## §6 Reference: the 5 spec files (verbatim paths)

```
docs/plans/2026-06-03-overseer-framing.md
docs/plans/2026-06-03-overseer-contracts.md
docs/plans/2026-06-03-overseer-prioritization.md
docs/plans/2026-06-03-overseer-build-sequence.md
docs/adr/0001-worker-facing-attribution-one-boss.md
```

Read all five before filing the first issue. The build-sequence doc has a "PR slicing" table that maps directly onto issue bodies. The contracts doc has the §1-§15 numbered contract references that issues should cite. The framing doc gives you the why; the prioritization doc gives you the engine specifics. The ADR is referenced by Steps 2.75 (invariant test stub) and 4 (invariant test activates).

Estimated read time: 30-45 minutes for thorough read. Estimated issue-filing time: 30-60 minutes. Total: 1-2 hours.
