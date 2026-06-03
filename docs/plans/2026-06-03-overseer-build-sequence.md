# Fleet attention arbitration (the Overseer) - build sequence

> **Status:** build sequence, Rev 4. The implementer's delivery-first read. Steps 1-6, MVP acceptance bar, MVP non-goals, surface scope, issue mapping, risks by phase.
> **Date:** 2026-06-03
> **Scope:** how this gets built, in what order, what counts as "done" at each step, what does not count as MVP. No architecture re-derivation; this doc trusts the framing and contracts docs and focuses on delivery.
> **Audience:** the implementation agent (human or otherwise) who has read framing + contracts already.

> Part of the Rev 4 split. Companion docs:
> - `2026-06-03-overseer-framing.md` - concept, model, voice-above-workers, decision channel
> - `2026-06-03-overseer-contracts.md` - implementation contracts §1-§4, §7, §8, §10-§15; schemas and taxonomies
> - `2026-06-03-overseer-prioritization.md` - prioritization contracts (§5 scoring loop, §6 replay harness, §9 attention budget); prior art
> - `2026-06-03-overseer-build-sequence.md` (this doc) - Steps 1-6 (incl. 2.5 and 2.75), MVP acceptance bar, non-goals, risks by phase
> - `docs/adr/0001-worker-facing-attribution-one-boss.md` - one-boss principle ADR

---

## MVP acceptance bar

The "first useful Overseer" finish line. Steps 1-4 work toward this; Step 5+ is post-MVP polish. Without an explicit acceptance bar the build acquires the gravity that pulls every architecture toward a neutron star of good intentions.

### Capabilities the MVP must demonstrate

| Capability | Acceptance test |
|---|---|
| **Events** | Workers emit typed events into the events table via the prompted event-emission contract; events with `attention_candidate = 0` (captured-only) are filtered from inbox candidacy; hub-observed event synthesis fills gaps where worker emission fails. |
| **Inbox** | `needs_decision` and `blocked` events become inbox items with computed `effective_priority`. |
| **Merge** | Same `dedupe_key` collapses multiple events into one inbox item with merged `source_event_ids`. Typed dependency edges via `event_links` enable root-cause surfacing ("X is blocking 5 workers"). |
| **Queue visibility** | Operator can see current surfaced item + next-up + queue-behind via voice ("what's queued?") and UI (inbox view). |
| **Voice query** | Operator can ask the Overseer "what needs me next?" and get a sensible answer pointing at the top inbox item. |
| **Provenance** | Overseer can explain why any surfaced item is at its position ("peer-15 reported blocked 12 minutes ago; severity 4; aged from priority 3 to 4 over the last hour"). |
| **Dispatch** | Operator-confirmed action creates a dispatch envelope (contracts §13), posts the rendered instruction once to the target worker session, and creates a `dispatched` event linked to the originating convo. Idempotency-keyed to prevent double-fire. |
| **One-boss invariant** | Worker session never sees Overseer attribution; rendered instruction reads as operator-from-operator. Verified by inspection of `messages` table rows and by a replay-harness golden test (ADR-001). |
| **Contradiction surfacing** | When CI says fail and worker self-report says pass (or analogous conflicts), Overseer surfaces the conflict rather than picking one. |
| **Replay** | At least 10 golden replay scenarios pass (see prioritization doc §6); CI gate prevents regressions on Overseer logic changes. |

### MVP non-goals (explicitly out of scope)

- **No salience learning.** Hand-tuned `base_priority` per event_type; no per-operator weight learning yet. Schema designed for it; not active.
- **No standing-order autonomy** (Stage 2). All dispatches require per-action operator confirmation.
- **No open-loop heartbeat autonomy** (Stage 3). Overseer doesn't act on a timer.
- **No channels integration** (issue #19 deferred). External sources don't emit into events yet; only worker emissions populate the substrate.
- **No mid-session live device handoff.** Cold-attach across surfaces is fine (close on desktop, reopen on mobile-web, voice convo resumes from server-side state). Hot handoff (mid-utterance desktop → bluetooth) is post-MVP.
- **No bounded-deferral mode auto-detection.** Modes (`live` / `quiet` / `focus` / `digest` / `panic`) are operator-set, not auto-detected from operator presence signals.
- **No native mobile app.** Mobile-web is sufficient post-MVP; native attachment is later.
- **No watch attachment.** Voice convo too constrained for a wrist surface; deferred indefinitely.

### MVP surface scope

The MVP acceptance bar is met on **desktop web** alone. Other surfaces ride along as HAPI's existing attachability allows, but they are not required to claim "first useful Overseer":

- **Web (desktop browser)**: MVP primary surface, day-one target. Steps 1-4 deliver MVP here.
- **Mobile-web**: becomes practically useful once the chrome voice surface lands in **Step 5** (post-MVP). The "shower-speaker conversation via mobile-web + bluetooth audio routing" use case is reachable from Step 5 onwards. Not required for MVP.
- **WebXR**: follows soon after Step 5; same chrome surface, different rendering. Post-MVP.
- **Native mobile app**: post-MVP polish; mobile-web is sufficient.
- **Watch**: deferred indefinitely.

Locking MVP to desktop web also locks the dispatch UX contract (Step 4) to one surface during the first build, which reduces the test matrix considerably.

---

## Deployment sequence (phased rollout)

The chrome-button move is the last UI step, not the first. The phased rollout ships substrate (persistence, events, inbox, Overseer entity) as small low-risk PRs first, so by the time the chrome-button move lands the user-facing surface is wired against working infrastructure rather than half-built scaffolding. The operator is also the daily user of the fleet being built, so the phasing is also about letting the substrate prove itself under real load before the operator-facing chrome shifts to depend on it.

### Step 1 - Voice persistence + receiving-session indicator (smallest shippable PR)

Scope:

- Voice conversation survives page navigation within the HAPI web UI.
- Voice conversation survives tab refocus.
- Visible indicator on the receiving session card AND a persistent pill in chrome ("voice → session X") - unmissable.
- If the operator navigates to a different session while voice is active in session A, the indicator continues showing "voice → A"; the operator can type into session B at the same time (multi-modal multi-task by design).
- If the underlying receiving session goes down mid-convo, voice layer surfaces it ("session A just dropped - end voice or spawn a fresh session?") rather than dying silently.
- Indicator data model accommodates future states: `voiceFocus: { kind: 'session' | 'overseer' | 'fleet', ref?: string }` so the chrome-button move later doesn't require a rewrite.

Low-risk first PR. Pure quality-of-life from the operator's POV. Builds the load-bearing persistence muscle.

### Step 2 - Events table + worker emission (next slice of infra)

Scope:

- Migration: add `events` table (with `artifact_refs`, `operator_action_required`, `risk_detected`) + `event_links` table + FTS5 virtual table. Full schema in contracts doc.
- Worker event taxonomy implemented (see contracts §1) via the **prompted event-emission contract**: the underlying agents (Cursor / Claude / Codex / etc) receive instructions (via HAPI's agent-instruction surface) to emit structured events at specific moments. This is a *prompt-level contract*, not a code-level API. (Naming deliberately avoids "prompt injection," which collides with the security-industry term for hostile prompt contamination.) Implications:
  - Emission is best-effort; LLM compliance varies by model.
  - Schema validation is defensive (events may arrive malformed; hub coerces or rejects).
  - The taxonomy doc is readable AS a prompt instruction.
  - Prompt phrasing is A/B-testable; the contract evolves via prompt iteration, not code rollout.
- **Hub-observed event synthesis layer**: when prompt compliance fails (worker doesn't emit `completed` despite finishing, worker doesn't emit `stale` despite long silence, worker doesn't emit `tool_result` despite an obvious tool call returning), the hub synthesizes the event from observable signals (process state, transcript activity, tool call patterns, last-output age).
- Read-only events viewer in the UI (debug pane) to confirm shape and density.
- No Overseer yet. Just the substrate.

Substrate-only. From the outside this looks like "HAPI got an activity log," which is accurate as far as it goes.

### Step 2.5 - Inbox substrate + v0 prioritizer

Without this step, Step 3's read-only Overseer has a mouth but no teeth - `query_inbox` and `explain_priority` would have nothing to query against. The inbox infrastructure must land before the conversational layer that consumes it.

Scope:

- Migration: add `inbox_items` table (see contracts §3) + a join/index path from `events.id` to `inbox_items.source_event_ids`.
- Event → inbox-candidate promotion job: walks new events, promotes those with `attention_candidate = 1` per the taxonomy.
- v0 priority scorer: hand-tuned `base_priority` per event_type + linear aging (see prioritization §5 v0 simplifications). No salience learning yet; no per-operator weights.
- Merge / dedupe: `dedupe_key` collapses repeated emissions into one inbox item, aggregating `source_event_ids`. `event_links` graph is walked for root-cause merging (5 workers `blocked_by` the same upstream → one fleet-level inbox item).
- `explain_priority(item_id)` provenance computation: stores the reason-for-priority string (event IDs, aging contribution, time-criticality bumps) at scoring time, so the read-only Overseer in Step 3 can recite the reasoning rather than reverse-engineer it on the fly.
- Read-only events + inbox viewer in the UI debug pane (expand the Step 2 viewer to show inbox state too).
- Still no Overseer entity, no voice attachment. Just the substrate that the Overseer will consume.

Substrate continues. UI gains an inbox view. From the outside this looks like "HAPI got a fleet inbox view," which is accurate.

### Step 2.75 - Replay harness v0 + CI gate

The MVP acceptance bar requires replay (above) and the prioritization doc (§6) says the harness must run in CI for every Overseer logic change. The harness has to exist *before* the Overseer's behavior gets complex enough to need it; retrofitting test coverage onto a working Overseer is how the project becomes vibes in a trench coat.

Scope:

- Captured-event-stream loader (reads events + event_links + inbox_items from a snapshot file, replays into a sandbox DB).
- Promotion + prioritization run-once entry point that can be invoked against a snapshot without touching production DB.
- Golden-scenario assertions for the starter set (see prioritization doc §6 table): 30 routine progress events surface nothing; same dedupe_key collapses; root-cause `blocked_by` chain surfaces upstream not symptoms; stale-item aging; etc. Initial target: at least 10 of the listed scenarios.
- **One-boss invariant test stub** (see ADR-001 §"Invariant test"): asserts that for every `dispatched` event, the corresponding worker-facing message row carries no Overseer-attribution metadata and the rendered instruction contains no generated attribution boilerplate. The stub passes vacuously at Step 2.75 (no dispatches exist yet) but the assertion shape is wired so Step 4's dispatch landing automatically activates real coverage.
- CI gate: harness runs on every PR touching Overseer logic, inbox scoring, event taxonomy, or worker-emission contract. Failure blocks merge.
- Captured fixtures live under `test/fixtures/overseer-replay/` and are NOT production transcripts (see contracts §7 transcript retention policy).

Test-discipline foundation. Steps 3-4 ship behind it; without it, persona iteration becomes uncheckable.

### Step 3 - Read-only Overseer wired to voice

Scope:

- Overseer is a real conversational entity with own session-equivalent in the hub.
- Voice entry reuses the existing voice-entry affordance where practical, but routes it to the Overseer on a dedicated Overseer surface (distinct from any per-session voice). The final chrome-level relocation - voice button physically *out* of per-session UI and into application chrome - happens in Step 5.
- Voice convos with the Overseer written into events table (`event_type = convo_turn`).
- Overseer cannot yet dispatch - only inform.

First user-facing surface of the Overseer. Per-session voice still exists; this is "ALSO you can talk to the Overseer about the fleet."

#### Read-only Overseer tool set

These are the tools the Overseer has available in Stage 0. All read-only; no dispatch, no confirm, no state mutation.

| Tool | Returns |
|---|---|
| `query_events(filter)` | Events stream filtered by session, project, type, severity, time window, status, `attention_candidate` flag. |
| `query_inbox(filter)` | Current inbox candidates + surfaced items + held intent items. |
| `get_session_state(id)` | Hub-observed state + last activity + tool call recency + `worker_reported_state` if available. |
| `get_session_recent_output(id, n)` | Last N transcript chunks for context. |
| `get_worker_health(id)` | Combined view: reported state + observed state + inferred state (see contracts §2). |
| `explain_priority(item_id)` | Provenance trail: why this item is at this position, with event IDs and aging history. |
| `list_active_workers(filter)` | Summary roster, filterable by project / state / age. |

Voice attachment turns these into "show me my fleet," "who's blocked," "what's next," "why is peer 15 ahead of peer 3."

### Step 4 - Disagreement-capable Overseer + voice dispatch with confirm

Scope:

- Overseer can propose dispatches in voice convo.
- Operator confirms in voice (or via UI button for noisy environments).
- Overseer drafts a dispatch envelope (contracts §13); the hub renders the operator-attributed message into the target worker session.
- All transactions recorded in events table with `related_event_id` linkage to the convo that produced them.
- Action lifecycle (contracts §4) fully tracked.
- Contradiction handling (contracts §14) active: Overseer pushes back when sources disagree.

#### Dispatch UX contract

When the Overseer dispatches into a worker session, the UI:

- **Does NOT** auto-navigate focus to the target session. The operator stays in the decision channel; yanking focus mid-thought breaks the conversation loop that the whole architecture is built around.
- **DOES** show a persistent indicator on the target session card: a small badge "↓ recent Overseer dispatch" with timestamp; fades after N minutes. Symmetric with the voice-attached indicator from Step 1, consistent visual language.
- **DOES** show an ephemeral toast/marquee near the Overseer chrome: "→ peer-15: '<rendered instruction>'" scrolls past, vanishes after a few seconds. Visual proof of delivery, not meant to be read. Like watching your chief of staff pick up the phone and dial - you don't listen, you just confirm it happened.
- **NEVER** dispatches silently. Always-visible delivery confirmation, because the operator needs proof the action fired vs. being eaten by an error.

The combo - persistent target-side indicator + ephemeral source-side confirmation, no focus follow - mirrors how voice-call-attached works today.

**MVP acceptance bar is met when Step 4 lands.** Steps 5+ are post-MVP.

### Step 5 - Chrome-button move + per-session button retirement

Scope:

- Chrome voice button becomes the primary voice surface; available on web, mobile-web, and webXR (all inherit HAPI's existing attachability).
- Per-session voice button removed (or kept as legacy with deprecation note).
- PTT remains for fast dictation.

By now persistence, indicator, events, Overseer-conversation infrastructure all exist. This is a UI cleanup, not an architectural change. From this point the "shower-speaker via mobile-web" use case is live.

### Step 6+ - Standing-order autonomy, channels, mobile polish, salience learning, webXR

Out of scope for this framing pass. Each is a discrete future workstream that builds on the MVP substrate.

---

## Issue mapping

HAPI issues this architecture collapses or affects:

| Issue | Effect | Lands in |
|---|---|---|
| **#11** per-session scratchlist | Absorbed into operator intent capture (contracts §15) | Step 2.5 substrate + Step 3 voice surface |
| **#14** controlplane / overseer | This IS that issue | Steps 3-4 |
| **#15** composer eats text on 4xx/5xx | Unaffected (peer building independently) | n/a |
| **#18** cross-session memory | Becomes saved-filter views over events table | Step 2 substrate + Step 3 query tools |
| **#19** channels | External sources emit into events as `source_kind=channel` | **Post-MVP** (Step 6+) |
| Various voice-* items | Either absorbed (cross-session voice, voice memory, voice routing) or made obsolete (per-session voice button) | Steps 1, 3, 5 |

Peers currently shipping **#11** (per-session scratchlist v1), **#15** (composer bug), and **#7** (backups) should proceed unaffected. The §15 absorption of #11 happens at fleet-level wiring (Step 2.5 + Step 3), not at the per-session scratchlist v1 the peer is shipping.

---

## Risks by phase

Pairing the framing-doc risk list with the step that introduces or exposes each.

### Step 1 - Voice persistence

- **Cross-device persistence is genuinely hard.** Server-side voice session state, multi-client attach, transcript replay, graceful failure when worker sessions die mid-convo. Step 1 only requires within-tab persistence; mid-session live handoff is post-MVP. Cold-attach is the MVP target.

### Step 2 - Events substrate

- **The events table is the new load-bearing wall.** Schema wrong, retrofit painful. Schema right, every future feature plugs in for free. The migration deserves specific review attention. Add `event_links` from day one; retrofitting typed dependency edges into a populated events table is much more painful than getting them in early.
- **Prompted event-emission is best-effort.** Workers will sometimes fail to emit events the taxonomy says they should. Hub-observed fallback (contracts §1) is essential; without it, the substrate has silent holes that the Overseer can't reason about. Build the fallback layer alongside the taxonomy, not later.

### Step 2.5 - Inbox substrate + v0 prioritizer

- **Filter quality has no obvious bootstrap.** The salience model starts with zero feedback signal. The first weeks it will get prioritization wrong. Mitigations: conservative defaults (under-surface rather than over-surface), explicit operator feedback commands (prioritization §5), short-term human-curated category weights. Without the explicit learning loop the constant-conversation goal stalls.

### Step 2.75 - Replay harness

- **Skipping or under-investing in this step is the single highest-leverage way to fail the whole project.** Without harness-backed assertions, Steps 3-4 ship behavior changes the team cannot tell improved or regressed the persona. Every Overseer prompt edit becomes a hand-eval; salience tuning becomes vibes. Build at least the 10-scenario starter set + the one-boss invariant stub. Treating the harness as "we'll add tests later" guarantees later never arrives.
- **Captured fixtures must NOT be production transcripts** (see contracts §7). Sanitized synthetic fixtures or explicitly captured non-production sessions only. Otherwise the harness ships operator transcript data into CI logs / artifact storage / public PR diffs.

### Step 3 - Read-only Overseer wired to voice

- **The persona is harder than the plumbing.** Most of the build is mechanically tractable. The Overseer voice itself - chief-of-staff authority, knows-when-to-push-back, never sycophantic, never robotic, distinctive enough that the operator wants to talk to it - is the load-bearing creative work and the easiest thing to get subtly wrong. Treat persona as a **distinct workstream with its own iteration cycle**, not a footnote of the implementation.
- **Disagreement protocol is a persona+capability problem entangled together.** Hard to test in isolation. Gate Step 4 (dispatch with confirm) until Step 3 (read-only) has demonstrated reliable visibility into worker state. Otherwise pushbacks will be wrong and the operator will learn to dismiss them.

### Step 4 - Dispatch with confirm

- **One-boss invariant must be enforced by the schema, not just by convention.** It's tempting to leave the rendered-instruction-vs-envelope distinction as "the renderer just won't include Overseer attribution." But that single oversight in a code path one day exposes Overseer source to a worker. Better: the worker-facing message renderer accepts only the envelope's `rendered_instruction` field plus operator metadata, with the envelope itself never reachable from the worker-facing API surface. CI test required (ADR-001 invariant test in the replay harness).
- **Voice security defaults need to be tight on day one.** It is much easier to loosen later than to tighten after the first accidental-dispatch incident. See contracts §8.

### Step 5 - Chrome-button move

- **The always-on inbox failure mode is real and underestimated.** A persistent decision channel can become persistent low-amplitude anxiety. Aggressive bounded-deferral defaults (prioritization §9), no notification sounds for routine items, clear visual distinction between "Overseer wants you" and "Overseer is processing." This is mostly UX but can kill adoption. The right product feels like "the queue is alive and I can re-enter it instantly," not "the machine is always talking to me."

### Cross-cutting

- **This is the largest single architectural commit HAPI has ever made.** Weeks of work, not days. Steps 1-2 are tractable evening-and-weekend; Step 2.5 is a focused multi-day build; Steps 3-4 are a focused multi-week build; Steps 5-6 are ongoing iteration.

### Named failure modes worth avoiding by design

- **"Slack with a posh accent"** - Overseer that surfaces everything; high-cost narrator, lower value than a search interface would deliver.
- **"Marvin with push notifications"** - Overseer with personality but poor judgement; chatty about its disappointments, contributes nothing.
- **"Clippy got into cocaine"** - Overseer that surfaces too eagerly, breaks operator flow, gets trained-away by operator closing tabs.
- **"Narrating log file"** - Overseer that describes worker activity without prioritizing it; busier than a log file, less queryable.
- **"Yes-man dispatcher"** - Overseer with no judgement; pure routing, no value-add over the chrome textbox.
- **"Very stupid Skynet"** - Overseer that takes voice commands from background audio and dispatches destructive actions.
- **"Bullshit cannon"** - Overseer that confidently synthesizes single answers from conflicting source signals; trust collapses on the first noticed instance.

---

## PR slicing (suggested)

Each step is at least one PR; some break further. Suggested slicing:

| Step | PR(s) | Rough scope |
|---|---|---|
| 1 | 1 PR | Voice persistence + receiving-session indicator |
| 2 | 1-2 PRs | Events schema migration; worker prompted-emission contract + wire format; hub-observed fallback (could be 2 PRs if migration and fallback land separately) |
| 2.5 | 1-2 PRs | Inbox schema migration; promotion job + v0 scorer; `explain_priority` |
| 2.75 | 1 PR | Replay harness v0; golden scenarios; one-boss invariant test stub; CI gate |
| 3 | 2-3 PRs | Overseer entity + session-equivalent; read-only tool set; voice route + `convo_turn` writeback |
| 4 | 2-3 PRs | Dispatch envelope schema + writer; voice-confirmation UX; dispatch UX contract (indicators + marquee); contradiction handling; one-boss invariant test activates against real dispatches |
| 5 | 1-2 PRs | Chrome voice button; per-session button retirement; mobile-web smoke tests |
| 6+ | many | each future workstream |

Total MVP PR count: rough estimate 9-14 PRs across Steps 1-4 (plus the Step 2.75 harness PR), over several weeks.

### Config values not to bikeshed now

Several time-window defaults appear in the architecture as "N days" / "N minutes" placeholders. Before implementation, these need concrete names (so they are configurable) but the values themselves are bikeshed-material that should NOT be settled at architecture time. Use these names; pick values at implementation:

| Config name | Used by | Architectural reference |
|---|---|---|
| `TRANSCRIPT_RETENTION_DAYS` | contracts §7 transcript expiry | "transcripts expire after N days" |
| `STALE_WORKER_MINUTES` | contracts §2 hub-observed `stale` synthesis | "no output for N minutes" |
| `DISPATCH_BADGE_TTL_MINUTES` | Step 4 dispatch UX contract | "fades after N minutes" |
| `DISPATCH_TOAST_SECONDS` | Step 4 dispatch UX contract | "vanishes after a few seconds" |
| `STALE_INBOX_HOURS` | prioritization §6 KPIs | "items >24h unresolved" |
| `ALARM_FLOOD_THRESHOLD` / `ALARM_FLOOD_WINDOW_MINUTES` | prioritization §6 KPIs | "alarm-flood detection" |
| `CHANNEL_DEDUPE_WINDOW_DEFAULT_MINUTES` | contracts §10 channel policy | "time window for collapsing repeated emissions" |
| `STANDING_ORDER_MAX_HOURS` | contracts autonomy Stage 2 | "for the next hour, if a worker..." |

Implementation owns the actual values. The architecture only owns that these are config, not constants.

---

## Companion docs

- `2026-06-03-overseer-framing.md` - concept, model, voice-above-workers, decision channel.
- `2026-06-03-overseer-contracts.md` - implementation contracts §1-§4, §7, §8, §10-§15; schemas and taxonomies.
- `2026-06-03-overseer-prioritization.md` - prioritization contracts (§5 scoring loop, §6 replay harness, §9 attention budget); prior art.
- `docs/adr/0001-worker-facing-attribution-one-boss.md` - one-boss principle ADR (load-bearing for Step 2.75 invariant test stub and Step 4 dispatch landing).
