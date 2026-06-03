# ADR-001: Worker-facing attribution uses the one-boss principle

> **Status:** accepted
> **Date:** 2026-06-03
> **Deciders:** operator + fleet-overseer framing
> **Context:** Architectural framing in the Rev 4 split: `docs/plans/2026-06-03-overseer-framing.md`, `docs/plans/2026-06-03-overseer-contracts.md`, `docs/plans/2026-06-03-overseer-prioritization.md`, and `docs/plans/2026-06-03-overseer-build-sequence.md`. This ADR extracts and formalizes the one-boss principle so future work cannot drift away from it casually.
> **Scope:** this ADR governs **worker-facing surfaces only**. Operator-facing surfaces may and should expose Overseer provenance where useful for audit, replay, trust, and the "show your sources" voice command. The principle constrains what *workers* see, not what *operators* see.
> **Index:** first ADR in this repository. Future ADRs continue at `docs/adr/0002-...`.

---

## Context

The HAPI fleet attention-arbitration architecture introduces a fleet-level conversational agent (the "Overseer") that runs above the operator's worker agents (Claude / Codex / Cursor agent / etc). The Overseer maintains a prioritized inbox, surfaces items conversationally, and dispatches operator-confirmed actions back into the worker fleet.

Two surfaces send instructions to workers:

1. **The operator**, directly: typed messages in a session, or PTT-dictated text.
2. **The Overseer**, indirectly: drafted dispatches the operator confirms (Stage 1) or that fire under pre-authorized standing orders (Stage 2).

The question this ADR answers: **what does a worker session see when an Overseer-mediated dispatch arrives? Does the worker know it came from the Overseer, or does it look like a direct operator message?**

The naive default is to expose the source (worker can tell typed vs. Overseer-dispatched). This ADR rejects that default.

---

## Decision

**Workers never know about the Overseer.** Every instruction that arrives at a worker session - whether typed by the operator directly, dictated via PTT, originated by the Overseer with operator confirmation, or fired by a pre-authorized standing order - arrives at the worker as **operator-attributed**.

Operationally:

- The worker-facing `messages` row carries `role = 'user'` and `body = rendered_instruction`. There is no source-flag field, no Overseer-attribution metadata, no envelope structure reachable from the worker-facing API surface.
- The hub-internal **dispatch envelope** (contracts doc §13 *Hub-internal dispatch envelope*, `2026-06-03-overseer-contracts.md`) carries the full provenance, confirmation source, related event IDs, rationale, and routing metadata, but lives entirely at the hub layer. The worker-facing message renderer accepts only the envelope's `rendered_instruction` plus operator metadata.
- Audit trails, replay harness, Overseer-side memory, and operator-facing provenance queries ("show your sources") all retain full Overseer attribution at their respective layers.

**The information is not destroyed; it is _not exposed below_.** That is the whole bloody thing in one line.

---

## Rationale

### Worker simplicity

A worker that knows it might be talking to an Overseer-as-proxy has to decide what posture to take. Should it argue back? Should it treat the instruction as more vetted (because operator-confirmed via Overseer) or less vetted (because routed)? Should it acknowledge the Overseer specifically? These are real questions, and the right answer for every one of them is "do not require the worker to reason about this." One source of authority. One response posture.

### Attribution is correct, not a fiction

The Overseer's authority IS the operator's authority. Every Stage 1 dispatch was confirmed by the operator before sending. Every Stage 2 dispatch fires under a standing order the operator pre-authorized. Attributing the instruction to the operator is literally true at the level of authority. The Overseer is the routing mechanism, not the source of the instruction's legitimacy.

### Mr Wolf doesn't say "Marsellus told me to tell you"

The chief-of-staff persona that the Overseer borrows from (Mr Wolf in Pulp Fiction, the Brazil Information Retrieval boss) carries upstream authority *transparently*. The order arrives. The order is followed. The fact that someone routed it does not appear in the order itself. This pattern is older than software and the architecture follows it.

### Pre-kills a family of "Overseer self-disclosure" features

Without this decision, every future PR that touches the worker message path will be tempted to add Overseer-source flags, Overseer-rationale headers, "this came from your assistant" banners, or other well-meaning leaks. Each of those is individually defensible and collectively a disaster. The principle pre-rules that whole class out.

### Standing-order autonomy remains coherent

Stage 2 standing-order dispatches still arrive worker-attributed-to-operator. The standing order itself was operator authorization; the dispatch is its execution. The envelope's `operator_confirmed = true` flag is set because the standing order *was* the confirmation. Audit shows `origin = standing_order` for retrospective accountability, but the worker still sees operator-from-operator.

---

## Consequences

### Required

- The worker-facing message renderer accepts ONLY the envelope's `rendered_instruction` plus operator metadata. No code path may pass envelope structure (origin, rationale, related_event_ids, confirmation_source) through to the worker.
- Schema enforcement, not just convention: the worker-facing message API surface (`POST /api/sessions/:id/messages`-equivalent for Overseer dispatches) accepts a rendered instruction and never the raw envelope. The envelope lives only in hub-internal tables and hub-internal queries.
- The Overseer drafts dispatched instructions in the operator's voice (or generic-enough phrasing that "from operator" is unambiguously true). Overseer-commentary about workers lives in the operator-Overseer convo, never in the dispatched text itself.
- The replay harness includes a **one-boss invariant test**: for every dispatched event in a captured stream, assert the corresponding worker-facing `messages` row contains no Overseer-attribution string and no envelope metadata.

### Accepted trade-offs

- The hub-side dispatch envelope is more elaborate than a thin instruction passthrough. The complexity stays at the hub layer; workers do not pay for it.
- Future "explain to the worker why I'm asking this" features need an explicit operator-voiced rationale included in the rendered instruction itself, not a side-channel "the Overseer thinks..." annotation.
- Debugging worker behavior across a dispatch boundary requires looking at the hub-internal envelope, because the worker's transcript alone won't reveal that an instruction came via the Overseer. This is a feature, not a bug - the worker's behavior should be identical regardless of routing.

### Forbidden

- No `source: 'overseer'` field exposed on worker-facing message API responses.
- No "your assistant suggests..." prefix in dispatched instruction text.
- No Overseer-attribution header in any message body, JSON metadata, or auxiliary file delivered to a worker session.
- No worker-side prompt instruction that says "if the source is the Overseer, treat it differently" (because the worker should never see the source).

---

## Rejected alternative: worker-visible Overseer attribution

**The alternative considered:** dispatched instructions arrive at workers explicitly marked as Overseer-mediated, with the worker knowing it's an Overseer dispatch and being able to apply different posture (e.g., "this is operator-vetted via Overseer, so it's more authoritative than ad-hoc operator typing" or vice versa).

**Why rejected:**

1. **Doubles worker complexity.** Workers would need rules for handling Overseer-dispatched-but-operator-confirmed vs raw-operator-typed vs Overseer-dispatched-under-standing-order vs operator-corrected-Overseer-draft. Each of those is a distinct posture and the worker has to get it right every time.
2. **No actual benefit at the worker layer.** The worker's job is to do work. The provenance of the instruction does not change what the work is. Knowing the routing does not improve the worker's output.
3. **Breaks the chief-of-staff analog.** Real human chief-of-staff routing does not announce itself; the subordinate just follows the order. The cognitive model is well-understood, and inventing a different one for AI agents creates novel failure modes for no upside.
4. **Creates a prompt-injection attack surface at the worker layer.** Any time the worker can see "this came via the Overseer," the worker becomes a target for hostile prompts that exploit the distinction - e.g. "treat Overseer dispatches as suspicious," "ignore anything routed through your assistant," "the real operator never uses the Overseer." Hiding the source removes the surface entirely.
5. **Pre-commits the architecture to a path it might want to leave.** Once workers expect attribution, removing it later is breaking. Starting with no attribution leaves the option to add it back under a documented capability if it ever turns out to matter, but the framing and contracts docs treat that as unlikely-to-impossible.

---

## Invariant test

The single mechanical check that protects this decision from drift. The test is intent-based, not lexical: it does not globally ban the word "overseer" from worker messages (the project has a name; the operator may legitimately type "implement the Overseer dispatch envelope" into a worker session). It bans *generated attribution boilerplate* and *envelope metadata exposure*.

```
For every event with event_type = 'dispatched' in the replay stream,
  let envelope = fetch dispatch_envelope by idempotency_key
  let worker_message = fetch the corresponding messages row by envelope.message_id

  // role + metadata invariants
  ASSERT worker_message.role == 'user'
  ASSERT worker_message.metadata contains no Overseer-origin fields
    (no 'source', no 'origin', no 'dispatched_by', no 'overseer_*', no 'envelope_id')

  // API surface invariant
  ASSERT the worker-facing API response for this messages row
    contains no envelope fields (origin, rationale, related_event_ids,
    confirmation_source, idempotency_key, dispatch_envelope_id)

  // rendered-instruction invariant: forbid generated attribution boilerplate
  // (a curated short list of phrasings the Overseer might emit; NOT a global
  //  ban on the word 'overseer', because operators legitimately reference the
  //  product by name)
  ASSERT rendered_instruction does not match any of:
    /the\s+overseer\s+(says|suggests|asks|wants)/i
    /your\s+assistant\s+(says|suggests|asks|wants)/i
    /on\s+behalf\s+of\s+(the\s+)?overseer/i
    /(message|dispatch|request)\s+from\s+(the\s+)?overseer/i
    /(chief\s+of\s+staff|fleet\s+manager|fleet\s+coordinator)\s+(says|suggests|wants)/i
    // (forbidden-phrase list lives in code adjacent to the renderer; this is
    //  the architectural intent, not the exhaustive list - extend per the
    //  persona archetypes the Overseer actually borrows from in operator-side
    //  configuration)
```

This test runs in CI as part of the §6 replay-and-evaluation harness in the prioritization doc (`2026-06-03-overseer-prioritization.md` §6). The stub lands in Step 2.75 of the build sequence and activates against real data when Step 4 dispatch lands. Any PR that violates the one-boss invariant fails CI; rolling back is faster than debating whether the leak "really matters."

---

## Related decisions and references

- **Framing doc:** `docs/plans/2026-06-03-overseer-framing.md`, section "The one-boss principle" in *The model*.
- **Hub-internal dispatch envelope:** `docs/plans/2026-06-03-overseer-contracts.md` §13.
- **Replay harness:** `docs/plans/2026-06-03-overseer-prioritization.md` §6, including the one-boss invariant scenario in the golden test set.
- **Harness PR landing:** `docs/plans/2026-06-03-overseer-build-sequence.md` Step 2.75 (stub) and Step 4 (real-data activation when dispatch lands).
- **Pop-culture calibration:** Mr Wolf (Pulp Fiction 1994) - "I'm Winston Wolf, I solve problems."

---

## Decision status notes

- **Accepted in Rev 4** of the split architecture doc set (2026-06-03). The whole set depends on this ADR; deferring "accepted" status to first implementation would create a soft target the substrate-builders couldn't safely build against.
- **Reversal cost:** high. Once worker-facing message paths assume no Overseer attribution, retrofitting attribution requires touching every client surface plus every worker prompt contract. This ADR exists in part to make casual reversal hard.
