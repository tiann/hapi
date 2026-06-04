# Fleet attention arbitration (the Overseer) - framing

> **Status:** framing, Rev 4. The "what is this and why" doc. Read this first.
> **Date:** 2026-06-03
> **Scope:** the conceptual model of HAPI's voice + fleet-control future. No schemas, no build steps - those live in the companion docs.
> **Audience:** anyone wanting to understand the architecture before reviewing contracts or implementation order.

> Part of the Rev 4 split. Companion docs:
> - `2026-06-03-overseer-framing.md` (this doc) - concept, model, voice-above-workers, decision channel
> - `2026-06-03-overseer-contracts.md` - implementation contracts §1-§4, §7, §8, §10-§15; schemas and taxonomies
> - `2026-06-03-overseer-prioritization.md` - prioritization contracts (§5 scoring loop, §6 replay harness, §9 attention budget); prior art
> - `2026-06-03-overseer-build-sequence.md` - Steps 1-6 (incl. 2.5 and 2.75), MVP acceptance bar, non-goals, risks by phase
> - `docs/adr/0001-worker-facing-attribution-one-boss.md` - ADR formalizing the one-boss principle

---

## TL;DR

The product HAPI is converging on is not "a voice agent." It is:

> **attention arbitration across a fleet of async workers.**

The operator runs many worker agents (Claude / Codex / Cursor agent / others) in parallel. Each worker produces events: progress, blockers, questions, completions. The operator's scarce resource is *which event deserves attention next*. Today nothing arbitrates - the operator polls sessions like a tired sysadmin in a Ridley Scott duct, voice exists per-session but goes nowhere, and parallel work creates parallel anxiety rather than parallel throughput.

The proposed architecture introduces a **single fleet-level conversational agent (the "Overseer")**, acting as the operator's chief of staff over the worker fleet. The Overseer reads a SystemEvent stream that workers continuously emit into, maintains a prioritized inbox of items needing operator judgement, surfaces them through a persistent voice conversation, and dispatches edicts back into the fleet with explicit confirmation. Per-session voice is demoted to dictation transport. Voice convo, inbox, and conversation memory persist across page navigation, devices, and restarts.

Foundational commitments before everything else:

- **Workers operate on async cadence; the Overseer operates in real time.** Voice belongs at the Overseer tier, never at the worker tier. The temporal mismatch is the architecture.
- **One boss.** Workers see only operator-attributed messages. The Overseer is invisible to workers. Every dispatch arrives at a worker as "from operator," whether typed directly, dictated via PTT, or originated by the Overseer with operator confirmation. Formalized in **ADR-001**.
- **Nothing attention-qualified disappears silently.** Raw mechanical and memory-bearing events may remain captured-only by design (schema field `attention_candidate = 0`), but anything promoted to the attention layer remains inspectable, with queue history and provenance.

The prioritization model borrows from OS scheduling, Cost of Delay, personalized importance prediction, notification deferral, and industrial alarm management - detail in the prioritization doc.

The architecture collapses HAPI issues **#11 (scratchlist)**, **#14 (controlplane / overseer)**, **#18 (cross-session memory)**, **#19 (channels)**, and several voice items into one coherent build estimated at *weeks*, not days. The deployment is sequenced dependency-first: ship the load-bearing infrastructure as small low-risk PRs *before* the chrome-button move, so the user-facing surface works on day one rather than landing alongside half-built substrate. The operator is also the daily user of the fleet being built, so the phasing is about giving the substrate time to prove itself under real load before the user-facing chrome shifts to depend on it. Build sequence in the build-sequence doc.

---

## The operator problem (what we are actually solving)

The operator's stated work style: **maintain as many workers in parallel as possible to create enough continuity across the top of all of them to sustain a conversation about the fleet.** The end-state is one in which the operator is never "waiting on agent X" because the Overseer is always indexing the fleet and surfacing what next needs the operator's judgement.

The reference picture is the Brazil (1985) Information Retrieval scene: the boss strides through, the human queue of people-needing-decisions parts and reforms behind him - "bang, bang, bang, bang" - all day. The *seductive* property is **decision-throughput unburdened by routing overhead.** The reason no human achieves it is that the cognitive overhead of context-switching has to live somewhere, and humans can't outsource it cleanly. The bet of this architecture is that machines can.

Today's HAPI has:

- A worker per session (Claude / Codex / Cursor agent / others) doing async work, owning their own context.
- A per-session voice button that opens a realtime conversation (ElevenLabs / Qwen / Gemini) pinned to that session.
- No persistent memory across sessions.
- No agent whose job is to read across the fleet and surface salient items to the operator.

Today's per-session voice button has three structural failures:

1. **It has no destination.** Voice output dies in the operator's earbuds; nothing flows back into the session's message stream as a record of the conversation. If the operator "shoots the shit" with voice, they produced zero artefact.
2. **It dies on page navigation.** Click away from the session and voice convo terminates; must restart. Smoking gun: voice is structurally tied to the *UI route*, not to a *persistent conversational entity*.
3. **It conflates worker-talking with operator-thinking.** Voice is *real-time conversational* (ms-s loop). Worker agents are *async by architecture* (10s-of-seconds to minutes per turn, because they read files, run tests, open PRs - real work takes real time). You cannot make a worker conversational without making it stop being a worker.

The current per-session voice model is not a bug. It is **the architecture telling on itself.** Voice has been pointed at the wrong layer.

---

## The model

```
┌─────────────────────────────────────────────────────────────┐
│                          Operator                           │
│                       wetware, decides                      │
└───────────────────────────┬─────────────────────────────────┘
                            │
                            │ voice convo (ms-s, real-time)
                            │ "what's next?"
                            │
┌───────────────────────────▼─────────────────────────────────┐
│                  Overseer (fleet chief of staff)            │
│                                                             │
│   - persistent, fleet-level, single instance                │
│   - voice-native real-time conversational interface         │
│   - chrome-level UI (NOT inside any session)                │
│   - reads SystemEvent stream                                │
│   - owns the prioritized inbox of attention-requiring items │
│   - dispatches edicts back to workers with confirmation     │
│   - distinct persona from worker agents                     │
│   - own memory (events table, FTS5-indexed)                 │
│   - INVISIBLE TO WORKERS (one-boss principle, ADR-001)      │
└───────────────────────────┬─────────────────────────────────┘
                            │
                ┌───────────┴───────────┐
                │ Prioritization layer  │
                │ aging + CoD + learned │
                │ per-operator salience │
                └───────────┬───────────┘
                            │
                            │ dispatches (rendered as operator-from-operator)
                            │ reads worker events
                            │
            ┌───────────────┴───────────────┐
            │                               │
            ▼                               ▼
┌───────────────────────┐         ┌───────────────────────┐
│   Worker session A    │         │   Worker session B    │
│   (Claude / Codex /   │   ...   │   (Claude / Codex /   │
│    Cursor agent)      │         │    Cursor agent)      │
│                       │         │                       │
│   - async cadence     │         │   - async cadence     │
│   - own context       │         │   - own context       │
│   - emits events      │         │   - emits events      │
│   - sees one boss     │         │   - sees one boss     │
└───────────┬───────────┘         └───────────┬───────────┘
            │                                 │
            └─────────────┬───────────────────┘
                          │
                          ▼
              ┌───────────────────────┐
              │   SystemEvent stream  │
              │   (SQLite + FTS5)     │
              │                       │
              │   - worker events     │
              │   - convo outcomes    │
              │   - edicts dispatched │
              │   - audit trail       │
              │   - event_links graph │
              └───────────────────────┘
```

### Three roles, three time zones

- **Operator** - intermittent, decisive, context-thin (relies on the Overseer for situational awareness)
- **Overseer** - always-on, real-time conversational, fleet-aware, context-rich
- **Workers** - async cadence, work-bound, narrow-context (own their slice deeply); they are not real-time conversational partners

These cannot collapse into each other. The Overseer is not a worker (workers operate on async cadence; the Overseer operates in real time). Workers are not the Overseer (the Overseer doesn't do the work). The operator is not the Overseer (a human cannot index hundreds of events per hour). The architecture lives in the *relationships* between them.

### The one-boss principle

A foundational architectural decision: **workers never know about the Overseer.** Every message that arrives at a worker session - whether typed by the operator directly, dictated via PTT, or originated by the Overseer with operator confirmation - arrives attributed to the operator.

> Formalized as **ADR-001** at `docs/adr/0001-worker-facing-attribution-one-boss.md`. The ADR captures decision, rationale, consequences, rejected alternative, and the mechanical invariant test that protects the decision from drift. Future changes to worker-facing attribution should update or supersede that ADR, not silently revise this section.

Rationale in brief (full treatment in the ADR):

- **Worker simplicity.** One source of authority, one response posture. No dual-boss complexity.
- **Authority is correct.** The Overseer's authority IS the operator's authority. Every dispatch is either operator-confirmed in real time or operator-authorized via standing order. Attribution to the operator is literally true.
- **Mr Wolf doesn't say "Marsellus told me to tell you."** He gives the order. Same model.
- **Pre-kills "Overseer self-disclosure" features.** Pre-rules out a whole class of well-meaning leaks before they get proposed.

What survives at the hub layer: a hub-internal dispatch envelope (see contracts §13) wraps every dispatch with provenance, confirmation source, related event IDs, and routing metadata. This is hub-internal; workers never see it. From the Overseer's POV, "I drafted this; operator confirmed it; I dispatched it" is the truth. From the worker's POV, "operator instructed me to X" is the truth. Both are true at different layers.

### The Overseer is chief of staff, not JARVIS

The mistake worth naming explicitly: **JARVIS is servant-genius**. The Overseer is closer to a **chief of staff with operational authority** - a role that exists in military and executive settings to absorb routing and triage so the principal's attention stays on decisions only the principal can make.

The substance of the role (the TPM analog with the TPM label stripped because it carries process-ceremony baggage in engineering culture):

> No one tells the chief of staff "give X to person Y." They tell the chief of staff "I need X done." Owning the routing - knowing who is jammed, who is fast at this kind of thing, what should happen in what order - is the chief of staff's job, not the principal's.

Persona implications:

- *Experienced.* Cynical-when-warranted. Has opinions about which workers are jammed today.
- *Confident but humble.* Knows when summarising vs. when knowing firsthand. Will say "let me ask peer-X" rather than confabulate.
- *Decisive within scope, deferential outside it.* Routes work; doesn't second-guess strategy.
- *Maintains the inbox.* The Brazil-pace "what's next" energy.
- *Pushes back crisply.* "Worker Y is mid-merge, want me to queue this or send it to Z?" - one clear question, not a clarification spiral.

Pop-culture references for tempo and posture (used internally to calibrate persona; not literal):

- **Mr Wolf** (Pulp Fiction): "I'm Winston Wolf, I solve problems." Matter-of-fact competence, low ceremony, decisive routing without grooming sessions.
- **The Brazil Information Retrieval boss**: the bang-bang-bang queue cadence.
- *NOT* JARVIS (too servile, too omniscient, no domain wisdom).
- *NOT* Clippy (too eager, no real authority, interrupts to "help").

Persona is treated as a **load-bearing workstream**, not a footnote of the architecture.

---

## Why voice belongs at the Overseer tier, not the worker tier

The transport reframe (voice = STT for worker input) was considered and rejected because it loses the conversational property. Restated as an axiom:

| Modality | Latency | Suited for |
|---|---|---|
| Voice convo | ms-s | Real-time conversation, sounding-board thinking, decision-making in dialogue |
| Worker text | 10s-min | Doing actual work (file edits, tests, PRs, HTTP calls) |
| Dictation (PTT) | ms-s | Fast typed input, no conversation, just transport |

A worker that runs in *seconds* stops being a worker (cannot do real work in seconds). A voice agent that operates at *minute* latency stops being a voice agent (cannot sustain conversation). So voice and worker are **mutually exclusive roles**, not the same agent with different I/O.

This axiom kills several "what if we just..." impulses before they start:

- *"What if voice is just STT into the worker?"* Then the conversation is with no one, because the worker can't respond in voice's timeframe. The operator already gets this experience today and it's the failure mode being solved.
- *"What if we make workers faster so they can be conversational?"* Faster models don't help - workers are slow because they're *doing things* (reading files, running tests). That asynchrony IS the worker's value. Infinitely fast models would still have to wait for IO.
- *"What if voice convos auto-summarise into worker messages?"* That's transport-with-extra-steps and it loses the *decision-making* property of the convo. The worker also now has noise to filter.

The cleaner answer: voice is the medium for operator ↔ Overseer. Workers receive text. Dictation (PTT) remains as fast input to workers when the operator wants to type-by-voice. Same tool today's per-session voice button *should* have been.

---

## The chrome-button insight

This is the architectural decision in a UI element.

The voice button moves *out* of the session UI and *into* the application chrome (always-visible dock, persistent across page navigation, survives device hop, attached to the operator's *session-with-Overseer* not to any particular worker session).

Once that move happens:

- Voice convos survive page nav (load-bearing for the whole architecture).
- Voice has a permanent attached entity (the Overseer) rather than an ephemeral per-page mic.
- "Which session is voice talking to right now" becomes a *visible state* the operator can change via voice command, UI affordance, or simply by *talking about a different worker*.
- Mobile / webXR cross-device attach becomes mechanically possible (any authenticated client on an existing HAPI surface can join the live Overseer session).

The per-session voice button is then *deleted*. To talk *about* what needs doing - talk to the Overseer. To dictate text fast into a specific worker - press PTT or type. Different tools, different jobs.

The chrome-button move is the last UI step, not the first; the phased rollout is in the build-sequence doc (Steps 1 → 5). The smallest shippable PR right now is voice persistence + receiving-session indicator (Step 1) - tractable, builds the load-bearing persistence muscle, low-risk.

---

## The decision channel

The operator described the end-state as a "constant conversation" with the Overseer. More precisely, the product is:

> **a persistent, interruptible, resumable decision channel.**

The distinction matters because "constant conversation" is seductive but dangerous - it slides toward Clippy-on-cocaine, anxiety-with-a-voice-model, Slack-with-a-posh-accent. The product should not feel like *"the machine is always talking to me."* It should feel like *"the queue is alive, and I can re-enter it instantly."*

The mental model: the Overseer maintains a **prioritized inbox** of items needing operator judgement, and the operator ↔ Overseer conversation works through it Brazil-style:

> "What's next?"
> "Peer-X says the migration shape is ambiguous, wants you to pick."
> "Pick option 2."
> "Done. What's next?"

This is the moonshot. **Not autonomy.** Decision-throughput unburdened by routing overhead.

### Prioritization quality IS the product

The Overseer's value is *which item it surfaces next.* The governing axiom:

> **No attention-qualified item should disappear without trace. Raw events may remain captured-only by design (schema flag `attention_candidate = 0`).**

That keeps the operator's "nothing gets hidden" intent intact while distinguishing it from the captured-only layer. The Overseer's job isn't *gatekeeper-deciding-what-you-deserve-to-hear*; it's *orderer-deciding-what-to-show-you-first.* Items that never make it to the top of the queue before being made obsolete by later events are *displaced*, not *suppressed*. Events flagged `attention_candidate = 0` (mechanical signals like `progress` and `tool_call`, plus memory-bearing records like `convo_turn` and `decided`) never compete for attention; they live in the substrate for query, not for surfacing.

The operator must have visibility into the queue-behind-current. If something has been pending for 4 hours waiting its turn, the operator must be able to ask "what else have you got queued?" and reorder ("bump that to next"). Without this escape hatch, prioritization-not-suppression has the same effect as suppression for low-priority items. The product surface includes inbox view, "what's queued and why" voice command, reorder/snooze/promote/"tell me about this next" controls, and "why didn't you tell me about X?" answerable with concrete queue history.

The formal grounding (OS aging, Cost of Delay, personalized importance prediction, non-stationary bandits) is in the prioritization doc.

### Bounded deferral required from day one

Sometimes the operator is sleeping, in a meatspace meeting, deep-focus on technical work, or simply doesn't want the inbox right now. The Overseer needs an off-switch that *isn't* "close the tab" - because closing the tab loses the queue.

The formal name is **bounded deferral** (Horvitz, User Modeling 2005). Five modes (`live` / `quiet` / `focus` / `digest` / `panic`) parameterize delivery cadence. The product is **always-available**, not **always-on**. Big difference.

Full mode policy in the prioritization doc.

### Persistence across devices is load-bearing infrastructure

Today voice dies on page navigation. Tomorrow the convo must survive: tab close, browser quit, desktop → phone → bluetooth earbuds, machine restart, hub restart. That requires *server-side voice session state* with multi-client attach, transcript replay so the new attach-point gets recent context, and graceful handling of underlying worker sessions going down mid-convo.

HAPI is already attachable across web, mobile-web, and webXR. **Cold-attach** (close on one surface, reopen on another) is the MVP target; **mid-utterance live handoff** (desktop → bluetooth headset without dropping a syllable) is post-MVP. See the build-sequence doc for surface scope.

### Disagreement protocol

The Overseer is management with authority, not a yes-man. If the operator says "send X to worker Y" and Y is mid-merge or wrong-context, the Overseer pushes back crisply:

> "Y is wedged, want me to queue it or send to Z?"

That requires:

- **Visibility into worker state via two channels**: the events stream (push - "something just happened") and the HAPI session API (pull - "what's the current state of peer 15, including stuff that didn't generate an event"). Push tells the Overseer WHEN; pull tells the Overseer WHAT now.
- Judgement about when to question routing vs. just route.
- A persona posture that pushes back *crisply* (not endlessly clarifying) and *deferentially* (the operator's authority is intact).

Yes-man Overseer = fancy dispatcher with no value-add over the chrome textbox. Too-pushy Overseer = irritating boss the operator will avoid. Mr Wolf is the calibration point.

The Overseer also faces conflicting claims (worker says tests pass, CI says fail; worker says blocked, hub-observed says active). Contradiction handling is contract §14 in the contracts doc.

---

## Risks worth taking seriously (summary)

Full risks list in the build-sequence doc; the load-bearing five for framing:

1. **The persona is harder than the plumbing.** Most of the build is mechanically tractable. The Overseer voice itself - chief-of-staff authority, knows-when-to-push-back, never sycophantic, never robotic, distinctive enough that the operator wants to talk to it - is the load-bearing creative work and the easiest thing to get subtly wrong. Treat persona as a distinct workstream with its own iteration cycle, not a footnote.

2. **Filter quality has no obvious bootstrap.** The salience model starts with zero feedback signal. First weeks it will get prioritization wrong. Conservative defaults plus explicit operator feedback commands buy time; without an explicit learning loop, the constant-conversation goal stalls.

3. **The events table is the new load-bearing wall.** Schema wrong, retrofit painful. Schema right, every future feature plugs in for free. Add `event_links` from day one; retrofitting typed dependency edges into a populated events table is much more painful than getting them in early.

4. **The always-on inbox failure mode is real and underestimated.** A persistent decision channel can become persistent low-amplitude anxiety. The right product feels like "the queue is alive and I can re-enter it instantly," not "the machine is always talking to me." Aggressive bounded-deferral defaults plus clear visual distinction between "Overseer wants you" and "Overseer is processing" are mandatory.

5. **One-boss invariant must be enforced by the schema, not just by convention.** Otherwise a single oversight in a code path one day exposes Overseer source to a worker. ADR-001 names the mechanical invariant test in the §6 replay harness.

Named failure modes worth avoiding by design:
- **"Slack with a posh accent"** - Overseer that surfaces everything; high-cost narrator.
- **"Marvin with push notifications"** - Overseer with personality but poor judgement.
- **"Clippy got into cocaine"** - Overseer that surfaces too eagerly, breaks operator flow.
- **"Narrating log file"** - Overseer that describes worker activity without prioritizing it.
- **"Yes-man dispatcher"** - Overseer with no judgement; no value-add over the chrome textbox.
- **"Very stupid Skynet"** - Overseer that takes voice commands from background audio and dispatches destructive actions.
- **"Bullshit cannon"** - Overseer that confidently synthesizes single answers from conflicting source signals.

---

## Open threads (where the diverging conversation paused)

Things not converged on yet, that the implementation will need to call:

- **What does the Overseer's failure mode look like operationally?** Recovery posture when prioritization is wrong, when surfaced item was wrong, when withheld item should have been hot. Confess and recalibrate? Operator-noticeable? Silent self-correct?
- **Inbox UI when 40 items deep.** List? Card stack? Voice-only with no UI for queue? Persistent sidebar?
- **Competing-priority tie-breaks.** Two `needs_decision` items at the same priority - which goes first? Most-recent? Most-blocked-downstream (via `event_links`)? Operator-weighted by source?
- **Multi-modal multi-task UX edge cases.** Voice convo with Overseer ABOUT worker X, while typing into worker Y - indicator design must distinguish that from voice transport INTO X.
- **Operator's role when the Overseer is dispatching well.** Spectator? Approver? Partner? Each implies different inbox cadence and a different sense of who's "driving."
- **External channels and direct-to-operator vs via-Overseer routing.** Calendar reminders bypass; CI failures via-Overseer; what about DMs from another HAPI agent? PagerDuty?
- **Intent item trigger evaluation.** Natural-language triggers ("after current PR lands") need parsing into an evaluatable condition. v0 may require operator-set explicit triggers only.

---

## Things to push back on (for second-eyes review)

We deliberately want this challenged on:

1. **Is the chief-of-staff framing the right persona archetype, or are we underselling what an LLM-native agent could be?** Chief of staff is a comfortable human role, ceiling-limiting. Is there a better archetype that's machine-native?
2. **Is "persistent decision channel" actually desirable, or will it produce burnout in practice?** The operator thinks they want it. Steelman "Overseer is silent until summoned, like Spotlight."
3. **Is extending SQLite right, or are we under-investing in the substrate?** Argue the case for NATS JetStream / Kafka / EventStore on the basis that this *will* outgrow SQLite within 18 months. Counter-argue.
4. **Is the dependency-first phased rollout wise, or does it defer a conceptual shift the operator should just take in one cycle?** Slow-rollout-with-buy-in vs. ship-the-whole-thing-at-once trade-off.
5. **Have we got Stage 0/1/2 autonomy gating right, or over-cautious?** Argue Stage 1 (confirm-per-action) is the right *permanent* posture, not a stepping stone.
6. **Is rejection of rollback complete?** Some actions (sending unread message, draft PR, queued notification) are reversible. The blanket no-rollback may over-rotate.
7. **One Overseer or many?** Doc assumes one persistent Overseer across all surfaces. Counter-argue per-surface instances with shared persona.
8. **Is the three-layer event/inbox model too rigid?** Could be just two (events + inbox) with `attention_candidate` as a derived view; or four (raw, classified, inbox-candidate, inbox-item). Trade-offs of each.
9. **Is the prioritization formula sketch (`base + aging + time_criticality - decay`) the right shape now that `event_links` carries dependency-graph semantics?** Should dependency-graph effects factor into `effective_priority` directly (worker A is blocked because worker B is blocked because dependency C is down → C should outrank A and B for operator attention), or stay separate as a routing-time consideration?
10. **Is the one-boss principle right?** ADR-001 commits to it; steelman the case for *transparent* Overseer authorship to workers - "worker should know an Overseer-confirmed dispatch is operator-vetted differently from raw operator typing, so it can apply different posture." The doc and ADR commit, but it's worth challenging because the decision constrains a lot downstream.
11. **Is the prompted event-emission contract too fragile?** Workers comply unevenly; hub-observed fallback covers some gaps but not all. Argue for a structured emission API on worker-side (worker SDK that emits events as code calls rather than as prompted output). Counter-argue (cost, friction, model-agnostic compatibility).
12. **Are any of the contracts WRONG**, vs. just immature? Worth challenging the *taxonomy* (§1), *state model* (§2), and the *one-boss envelope* (§13) specifically - these are hardest to revise post-build.
13. **What's missing entirely?** Likely blind spots. Pre-Mortem encouraged: imagine this shipped and was a flop, what was the cause?

---

## References

### Pop-culture calibration

- Brazil (1985) - Information Retrieval boss; bang-bang-bang queue cadence.
- Mr Wolf (Pulp Fiction 1994) - "I'm Winston Wolf, I solve problems"; decisive routing-without-ceremony posture; one-boss invariant calibration ("doesn't say Marsellus told me to tell you").

### HAPI issues this collapses

- **#11** per-session scratchlist (absorbed into contracts §15 operator intent capture)
- **#14** controlplane / overseer agent (this IS that issue)
- **#15** composer eats text on 4xx/5xx (peer currently building - unaffected)
- **#18** cross-session memory
- **#19** channels (inbound external messages)
- Various voice-* items in the recent issue batch

### Companion docs

- `2026-06-03-overseer-contracts.md` - implementation contracts §1-§4, §7, §8, §10-§15; schemas and taxonomies.
- `2026-06-03-overseer-prioritization.md` - prioritization contracts (§5 scoring loop, §6 replay harness, §9 attention budget); prior art.
- `2026-06-03-overseer-build-sequence.md` - Steps 1-6 (incl. 2.5 and 2.75 replay harness), MVP acceptance, non-goals, risks by phase.
- `docs/adr/0001-worker-facing-attribution-one-boss.md` - one-boss principle ADR.

---

## Process notes

- This is Rev 4 framing, split from the unified Rev 3.1 single-doc.
- Framing-doc content stops here: this is the "what is this and why" surface. Implementation details live in the companion docs.
- The framing thesis stable as of Rev 3.1; Rev 4 is a reorganization for implementer audience, not a content rewrite.
