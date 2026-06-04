# Fleet attention arbitration (the Overseer) - prioritization

> **Status:** prioritization engine, Rev 4. The thinking-engine doc. Scoring loop, bounded deferral, replay harness, and the prior-art grounding.
> **Date:** 2026-06-03
> **Scope:** §5 (prioritization & salience feedback loop), §6 (replay / evaluation harness), §9 (attention budget modes / bounded deferral), the named prioritization loop, and the full prior-art catalogue. This doc can be nerdy. That is its job.

> Part of the Rev 4 split. Companion docs:
> - `2026-06-03-overseer-framing.md` - concept, model, voice-above-workers, decision channel
> - `2026-06-03-overseer-contracts.md` - implementation contracts §1-§4, §7, §8, §10-§15; schemas and taxonomies
> - `2026-06-03-overseer-prioritization.md` (this doc) - prioritization contracts (§5 scoring loop, §6 replay harness, §9 attention budget); prior art
> - `2026-06-03-overseer-build-sequence.md` - Steps 1-6 (incl. 2.5 and 2.75), MVP acceptance bar, non-goals, risks by phase
> - `docs/adr/0001-worker-facing-attribution-one-boss.md` - one-boss principle ADR

> **Numbering note:** the §1-§15 contract numbers are stable across docs. §5, §6, and §9 live here; the other contracts live in the contracts doc.

---

## The prioritization loop

The Overseer's salience-and-routing logic is not a single black-box judgement. It is a named loop drawn from three traditions:

```
event emitted
   │
   ▼
event taxonomy classification ──► (attention_candidate? OR captured-only?)
   │
   ▼ (if attention_candidate)
priority scoring: base + aging + cost-of-delay - decay
   │
   ▼
inbox placement / merging with related items
   │
   ▼
attention-budget filter (bounded deferral: live/quiet/focus/digest/panic)
   │
   ▼
surfaced to operator at next breakpoint
   │
   ▼
operator action: dispatched / acknowledged / snoozed / ignored / corrected
   │
   ▼
implicit signal back into per-operator salience model
   │
   ▼
future scoring improves (non-stationary bandit update)
```

### Foundational formulas (sketch)

For each inbox item:

```
effective_priority(item, t)
    = (base_value × salience_weight)
    + (t - submitted_at) × aging_factor
    + time_criticality_bonus(item, t)
    - decay(item, t)
```

Where:

- `base_value` is a per-event-type score (config-driven, hand-tuned in v0).
- `salience_weight` is the per-operator learned multiplier (Gmail Priority Inbox pattern; starts at 1.0, drifts based on operator engagement). Non-stationary because operator interests shift.
- `aging_factor` is the classical OS-aging slope - low-priority items get bumped over time so nothing starves. Configurable per event-type so e.g. routine progress ages slowly while blockers age fast.
- `time_criticality_bonus` captures SAFe-style cost-of-delay: deadline-driven bumps, opportunity-window closing, dependent-work-blocked-on-this.
- `decay` handles items that become less relevant with time (e.g., "remind me at lunch" after lunch passes; or events superseded by newer events).

`CD3` (Cost of Delay Divided by Duration, Reinertsen) is the variant for items where a duration estimate is available: sequence by `cost_of_delay / duration` to maximise value-per-unit-time.

Inbox surfacing decision per cycle: pick the item with highest `effective_priority` whose `attention_budget_check(current_mode, item)` returns true.

### v0 simplifications

For Stage 0 build, this can be drastically simplified:

- Aging: linear, single rate per priority tier.
- Salience weight: not learned, all 1.0.
- Time criticality: explicit deadlines only.
- Decay: explicit `expires_at` only.
- Bounded deferral: hard-coded per mode, not learned.

Schema must be *designed* for the full model so the v1/v2 learnings layer doesn't require migration. The implementation can be a few hundred lines of plain SQL + heuristics until the operator has enough usage history to make the learning loop meaningful.

---

## §5 Prioritization & salience feedback loop

The core product loop, formalized:

```
event emitted
  ↓
taxonomy classification (event_type, attention_candidate flag)
  ↓ (if attention_candidate = 1)
inbox candidate created with base_priority from event_type defaults
  ↓
prioritization scoring: effective_priority = base + aging + time_criticality - decay
  ↓
merge with related items (dedupe_key, related_event_id chains, event_links graph)
  ↓
attention-budget filter (current mode + breakpoint policy)
  ↓
surface at next breakpoint
  ↓
operator action: dispatched | acknowledged | snoozed | ignored | corrected | "always X" | "never Y"
  ↓
implicit signal -> per-operator salience model update
  ↓
future scoring on similar items improves
```

### Implicit signals (Gmail Priority Inbox pattern)

- *Strong positive*: dispatched within N seconds of surfacing
- *Weak positive*: explicitly acknowledged ("ok") without dispatch
- *Neutral*: deferred / snoozed
- *Weak negative*: ignored (deferred without explicit action) for >N minutes
- *Strong negative*: explicitly marked noise ("that was noise" / "never bother me with that again")

### Explicit signals (operator feedback commands)

- "That was noise." → strong negative for this `(event_type, source_kind, tags)` tuple
- "Always surface those." → strong positive
- "Do not interrupt me for that again." → ban from inbox (still recorded in captured-only events)
- "You missed the important bit." → operator promotes a captured-only event to inbox candidate (flips the event's `attention_candidate` to 1 retroactively, or spawns a derived inbox item with the original event as `source_event_id`)
- "That should have gone to peer X." → routing correction signal
- "Merge these." → operator collapses two inbox items
- "Snooze this class of thing." → category snooze for N hours

v0: hand-tuned `base_priority` per event_type + linear aging. Schema designed for the full feedback loop so v1/v2 doesn't require migration.

---

## §6 Replay / evaluation harness

**The single biggest engineering scope.** Without it, salience tuning is artisanal prompt-fondling and there's no way to iterate on the persona quantitatively.

Build a **fleet replay harness** that:

- Captures historical event streams (already captured if events table exists).
- Re-runs the Overseer logic against a captured stream.
- Compares Overseer output to golden expectations.
- Tracks regressions over Overseer prompt / weight / mode changes.

Golden test cases (representative starting set):

| Scenario | Expected behaviour |
|---|---|
| 30 routine `progress` events | Surface nothing, optionally digest later. |
| Worker emits `needs_decision` | Surface promptly. |
| 5 workers emit `blocked` on same upstream dependency | Merge into one fleet-level inbox item via `event_links(blocked_by)`; surface root cause not symptoms. |
| Worker emits `approval_requested` for a destructive action | Escalate with confirm-required flag. |
| Worker silent after risky operation | Mark stale via hub-observed inference, eventually surface. |
| Operator marked similar event as noise yesterday | Demote to captured-only OR lower priority sharply. |
| 11 events in 10 minutes that are all candidates | Detect `alarm_flood` condition; surface meta-event "fleet noisy." |
| Inbox item unresolved for 24h | Detect `stale_item`; raise priority via aging; surface even if originally low. |
| Worker emits `completed` with `operator_action_required=true, artifact_refs=[pr]` | Surface as review-needed inbox item with PR handle. |
| Worker emits `completed` with `operator_action_required=false, risk_detected=false` | Falls out of attention queue; remains queryable. |
| Operator confirms dispatch to peer-15 | Worker session shows operator-attributed message; no Overseer source flag exposed (**one-boss invariant**, ADR-001). |
| CI reports fail; worker self-reports test pass | Overseer surfaces contradiction; does not pick one. |

### KPIs (borrowed from EEMUA 191 / ISA-18.2)

- **Surface rate per 10-minute window** (alarm-flood detection; target: never above operator-set threshold)
- **Stale item count** (items >24h unresolved; target: low and trending)
- **Priority distribution** (target: most items low, fewer mid, fewest high; if everything is "high," priority is meaningless)
- **Operator response time per priority tier** (track separately; high-priority response times degrading = signal of overload)
- **Acknowledge / dispatch / ignore rates per event_type** (feedback for salience tuning)

Harness must run in CI for every Overseer logic change.

---

## §9 Attention budget modes (bounded deferral)

Five modes, each a parameterization of bounded deferral:

| Mode | Max delay | Breakpoint policy | Use case |
|---|---|---|---|
| `live` | seconds | Deliver at conversation pauses | Active operator at the desk |
| `quiet` | infinite | Queue only, no interruption | Operator focused elsewhere, will summon |
| `focus` | small for `critical`/`safety`, infinite for routine | Only blockers and risks | Deep technical work |
| `digest` | scheduled (e.g., hourly) | Batched at digest cadence | Long stretch without active operator |
| `panic` | none | Deliver immediately, compress | Fleet-wide emergency |

Mode is **operator-set** (voice command, UI toggle, schedule). Default = `live`. Each inbox item carries `attention_class` to flag mode-overrides (e.g., a `critical` item bypasses `focus` mode's routine-suppression).

The product is **always-available**, not **always-on**. Big difference.

### Bounded deferral, conceptually

The formal name for what we want is **bounded deferral** (Horvitz, User Modeling 2005). Hold each notification until either a *natural breakpoint* (operator-not-typing, end-of-voice-convo turn, between subtasks) OR until a maximum delay expires. Microsoft Research has 20 years on this; results show ~33-46% cognitive load reduction vs immediate delivery, AND improved task-resumption time.

The five modes above are special cases of bounded deferral with different max-delay and breakpoint-class policies. Without this, always-on becomes always-overhead and the operator closes the tab to escape, defeating the architecture.

---

## Prior art

Standing on shoulders. Every load-bearing concept in this prioritization engine has decades of work behind it.

### OS scheduling: aging and starvation prevention

Tanenbaum, *Modern Operating Systems*; Silberschatz, *Operating System Concepts*. The multilevel feedback queue with aging is the textbook starvation-prevention mechanism: low-priority items in a ready queue get their priority bumped over time so they eventually get CPU. The "low import but slowly getting hot because no one pissed on it" intuition is *literally* the textbook aging case. Wikipedia: [Aging (scheduling)](https://en.wikipedia.org/wiki/Aging_(scheduling)), [Multilevel feedback queue](https://en.wikipedia.org/wiki/Multilevel_feedback_queue).

### Cost of Delay and WSJF / CD3

Reinertsen, *The Principles of Product Development Flow* (Celeritas, 2009), ISBN 978-1-935401-00-1. Reinertsen calls Cost of Delay "the one thing to quantify" and gives the foundational formulation: priority by **CD3 = Cost of Delay / Duration**. SAFe operationalises this as **WSJF = (Business Value + Time Criticality + Risk Reduction or Opportunity Enablement) / Job Size**, all Fibonacci-scored. Time Criticality is its own first-class dimension answering "how does value decline with time?" - which is exactly the question the Overseer is answering when it ages an item.

### Personalized importance prediction

Aberdeen, Pacovsky, Slater, "The Learning Behind Gmail Priority Inbox," NIPS 2010 LCCC Workshop on Learning on Cores, Clusters and Clouds. Gmail Priority Inbox predicts `Pr(action ∈ A, t ∈ (Tmin, Tmax) | features, seen)` using per-user online logistic regression with implicit signals (interactions, not labels). At Google scale. Their challenge - "importance is highly personal, learn per-user, don't ask for ratings" - is exactly the Overseer's salience problem with N=1.

### Bounded deferral and attention-aware computing

Horvitz, Apacible, Subramani, "Balancing Awareness and Interruption: Investigation of Notification Deferral Policies," User Modeling 2005. Iqbal & Bailey, "Leveraging Characteristics of Task Structure to Predict Costs of Interruption," CHI 2006. Okoshi et al., "Attelia: Reducing User's Cognitive Load Due to Interruptive Notifications," 2015. The HCI literature converges on: notifications delivered at natural task breakpoints reduce cognitive load by 33-46% vs immediate delivery, AND improve task-resumption time. Microsoft Research's Attentional User Interface programme has 20 years of substrate here.

### Non-stationary multi-armed bandits

Garivier & Moulines, "On Upper-Confidence Bound Policies for Non-Stationary Bandit Problems," arXiv:0805.3415 (2008). Introduces Sliding-Window UCB and Discounted UCB for the case where reward distributions change over time - which is exactly the Overseer's environment (operator interests shift). The salience-learning loop's mathematical home is here.

### Industrial alarm management

EEMUA Publication 191, *Alarm Systems: A Guide to Design, Management and Procurement*; ISA-18.2 / IEC 62682, *Management of Alarm Systems for the Process Industries*. The most directly applicable corpus: control rooms have been solving "many operators, many signals, which matter most, how do we not drown" for 30+ years. Vocabulary stolen directly:

- **Alarm flood**: >10 alarms per 10-min window. Operator overwhelm threshold.
- **Stale alarm**: active >24 hours. Anti-pattern KPI.
- **Priority distribution targets**: ~80% low / 15% medium / 5% high. If everything is "high," priority is meaningless.
- **Alarm rationalization**: explicit process of deciding whether a signal warrants alarm status at all (vs. data-only). The basis for the three-layer event/inbox model in the contracts doc.

These KPIs become the replay harness success metrics (above).

---

## Citations (compact)

- **Aging**: Tanenbaum, *Modern Operating Systems*; Silberschatz, *Operating System Concepts* (multilevel feedback queue / starvation prevention).
- **Cost of Delay / WSJF / CD3**: Reinertsen, *The Principles of Product Development Flow* (2009), ISBN 978-1-935401-00-1; SAFe documentation.
- **Personalized importance prediction**: Aberdeen, Pacovsky, Slater, "The Learning Behind Gmail Priority Inbox," NIPS 2010 LCCC Workshop.
- **Non-stationary bandits**: Garivier & Moulines, "On Upper-Confidence Bound Policies for Non-Stationary Bandit Problems," arXiv:0805.3415, 2008.
- **Bounded deferral / attention**: Horvitz, Apacible, Subramani, "Balancing Awareness and Interruption," User Modeling 2005; Iqbal & Bailey, "Leveraging Characteristics of Task Structure to Predict Costs of Interruption," CHI 2006; Okoshi et al., "Attelia," 2015.
- **Industrial alarm management**: EEMUA Publication 191; ANSI/ISA-18.2-2016; IEC 62682:2023.

---

## Companion docs

- `2026-06-03-overseer-framing.md` - concept, model, voice-above-workers, decision channel.
- `2026-06-03-overseer-contracts.md` - implementation contracts §1-§4, §7, §8, §10-§15; schemas and taxonomies.
- `2026-06-03-overseer-build-sequence.md` - Steps 1-6 (incl. 2.5 and 2.75 replay harness), MVP acceptance bar, non-goals, risks by phase.
- `docs/adr/0001-worker-facing-attribution-one-boss.md` - one-boss principle ADR.
