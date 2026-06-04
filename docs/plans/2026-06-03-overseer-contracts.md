# Fleet attention arbitration (the Overseer) - contracts

> **Status:** contracts, Rev 4. The implementer reference. Schemas, taxonomies, and the contracts that must be nailed down before serious code lands.
> **Date:** 2026-06-03
> **Scope:** event schema, `event_links`, `artifact_refs`, worker event taxonomy, worker state model, inbox item model, action lifecycle, memory promotion, security, channel policy, provenance, cost/latency, dispatch envelope, contradiction handling, operator intent capture.

> Part of the Rev 4 split. Companion docs:
> - `2026-06-03-overseer-framing.md` - concept, model, voice-above-workers, decision channel
> - `2026-06-03-overseer-contracts.md` (this doc) - implementation contracts §1-§4, §7, §8, §10-§15; schemas and taxonomies
> - `2026-06-03-overseer-prioritization.md` - prioritization contracts (§5 scoring loop, §6 replay harness, §9 attention budget); prior art
> - `2026-06-03-overseer-build-sequence.md` - Steps 1-6 (incl. 2.5 and 2.75), MVP acceptance bar, non-goals, risks by phase
> - `docs/adr/0001-worker-facing-attribution-one-boss.md` - ADR formalizing the one-boss principle (load-bearing for §13)

> **Numbering note:** the §1-§15 contract numbers are stable across docs. §5 (prioritization & salience feedback loop), §6 (replay / evaluation harness), and §9 (attention budget modes / bounded deferral) live in the prioritization doc; §1-§4, §7, §8, §10-§15 live here. Gaps in the numbering reflect the split, not missing contracts.

---

## SystemEvent stream - the substrate

The substrate is the events table plus its companion link table and artifact-handle convention.

### What HAPI stores today (live data)

`~/.hapi/hapi.db` SQLite, ~107MB. Seven tables, four with rows of interest:

| Table | Rows (2026-06-02) | Holds |
|---|---|---|
| `sessions` | 82 | session metadata |
| `messages` | 72,874 | every per-session message (user, agent, tool-call, tool-call-result, event) |
| `machines` | 2 | runner machines |
| `push_subscriptions` | 4 | web push |
| `fcm_devices` | 1 | Android push |
| `users` | 0 | (single-operator deployment) |

HAPI already has a structured per-session message log with rich payload types. It does **not** have a cross-session event log: there's no row for "operator filed an idea," "Overseer dispatched task X to worker Y," "channel pushed event," "session A spawned session B." Those events don't exist today and need to.

### The "nothing suppressed" policy, fully stated

The Overseer does not suppress attention-qualified items silently. It may classify raw mechanical or memory-bearing events as captured-only (`attention_candidate = 0`), and it may defer, merge, snooze, or obsolete inbox candidates, but anything promoted into the attention layer must remain inspectable with queue history and provenance.

The captured-only classification is **not** suppression; it is *not-promoting-to-attention*. Captured-only events remain fully captured, fully queryable, fully replay-able. They do not compete for the operator's attention. The promotion gate (`attention_candidate` boolean) is governed by the event taxonomy in §1, defaulting to `false` (safer default: unknown event types do not push the operator).

### Three-layer event/inbox model

The operator's "nothing should be suppressed" correction holds for *attention-requiring items*. But the events stream itself includes lots of mechanical data (token streams, routine heartbeats) AND memory-bearing data (operator-Overseer convo turns, decisions, dispatched edicts) that should never become attention-requiring. EEMUA 191's alarm-rationalization process is the prior art here: not every signal warrants alarm status, even at low priority.

The three layers:

| Layer | Lives in | Promoted from | Promoted to |
|---|---|---|---|
| **Captured-only event** | `events` table | any emission with `attention_candidate = 0` (mechanical signals + memory-bearing records: `progress`, `tool_call`, `convo_turn`, `decided`, `dispatched`, etc.) | nothing (queryable, never surfaced for attention) |
| **Inbox candidate** | `events` table | emission with `attention_candidate = 1` per taxonomy | inbox via prioritization |
| **Inbox item** | `inbox_items` table | candidate that passed prioritization | operator attention via bounded deferral |

The captured-only layer carries two distinct populations: **mechanical signals** (token streams, routine progress logs, heartbeats - thousands per hour) and **memory-bearing records** (operator-Overseer convo turns, decisions, dispatched edicts - the audit and replay substrate). Both are fully captured, fully searchable, never cost operator attention.

The inbox-candidate layer carries blockers, decisions-needed, completions-with-action-required, anomalies, questions - tens per hour. Eligible for prioritization scoring.

The inbox-item layer is the operator's actual queue. Reorderable, snoozeable, mergeable. Nothing in this layer is suppressed; everything surfaces eventually unless made obsolete.

### Verdict: extend SQLite with `events` and `event_links` tables, do not introduce graph or KV

```
events(
  id                       INTEGER PRIMARY KEY,
  ts                       INTEGER NOT NULL,         -- ms epoch
  source_kind              TEXT    NOT NULL,         -- worker | overseer | operator | system | channel
  source_ref               TEXT,                     -- session id, machine id, channel id
  sink_kind                TEXT,                     -- worker | overseer | operator | fleet | null
  sink_ref                 TEXT,
  event_type               TEXT    NOT NULL,         -- progress | blocked | needs_decision | completed | failed | ...
  attention_candidate      INTEGER NOT NULL DEFAULT 0, -- 1 = eligible for inbox; 0 = captured-only (mechanical OR memory-bearing). Default 0 is the safe default - unknown event types do not push the operator.
  operator_action_required INTEGER NOT NULL DEFAULT 0, -- bool; salience starts here
  risk_detected            INTEGER NOT NULL DEFAULT 0, -- bool; worker is flagging a caveat
  summary                  TEXT    NOT NULL,
  payload_json             TEXT,
  artifact_refs            TEXT,                     -- JSON array; commits, PRs, files, URLs, deploy IDs (see below)
  tags                     TEXT,
  related_session_id       TEXT REFERENCES sessions(id),
  related_event_id         INTEGER REFERENCES events(id), -- simple parent-of; use event_links for typed edges
  dedupe_key               TEXT,
  expires_at               INTEGER,
  provenance               TEXT,                     -- where the claim came from
  idempotency_key          TEXT,
  confidence               REAL,                     -- 0.0-1.0; worker may be unsure
  severity                 INTEGER                   -- 1-5; tunes default priority within type
)
```

Plus an FTS5 virtual table over `summary + tags + payload_json` for recall queries.

**Artifact references** carry handles to things workers produce. Without these, the Overseer can say "peer-X opened a PR" but can't carry the operator straight to it - which breaks the bang-bang-bang loop. Handles enable action, not just narration.

```
artifact_refs structure (JSON array):
[
  {
    "kind": "github_pr",       -- github_pr | github_issue | commit | branch | file_path | diff |
                               --  log_url | screenshot | url | doc | deploy_id | session_id
    "url": "...",              -- canonical link if applicable
    "title": "...",            -- short human-readable
    "ref": "...",              -- SHA / id / path / etc, when no URL
    "source": "worker",        -- worker | tool_output | external | inferred
    "created_at": 123456789
  }
]
```

**Typed dependency edges** between events live in a separate `event_links` table, because `related_event_id` (single parent-of pointer) is too weak for the dependency semantics the Overseer needs to do root-cause synthesis:

```
event_links(
  id            INTEGER PRIMARY KEY,
  from_event_id INTEGER NOT NULL REFERENCES events(id),
  to_event_id   INTEGER NOT NULL REFERENCES events(id),
  relation_type TEXT NOT NULL,  -- spawned | blocks | blocked_by | supersedes | resolves | caused_by | duplicates
  created_at    INTEGER NOT NULL,
  metadata_json TEXT             -- optional, e.g. confidence in the inferred edge
)
```

This is what unlocks root-cause synthesis. If five workers are blocked because GitHub auth is broken, the Overseer should be able to surface:

> "GitHub auth is the root blocker affecting 5 workers."

Not:

> "Peer 1 is blocked. Peer 2 is blocked. Peer 3 is blocked. Peer 4 is blocked. Peer 5 is blocked."

The first is chief of staff. The second is narrating log file.

**Why not graphdb:** "session A spawned B that filed C" is FK edges; the typed edges go in `event_links`. SQLite handles both at this scale. A graphdb adds ops cost for marginal query-flex win.
**Why not KV:** wrong primitive. We need ordering + filtered range queries + full-text. KV punishes all three.
**Why not Kafka / NATS:** single-machine single-operator deployment. Overkill.

### Decision-vs-edict artefact distinction

When the operator types a message into a worker session today, the artefact is a single row in `messages` representing the edict.

When the operator converses with the Overseer and an edict emerges from that conversation, the artefact is *three things plus an envelope*:

- the conversation segment (events with `event_type = convo_turn`, threaded by `related_event_id`)
- the decision moment (event with `event_type = decided` linking to the convo)
- the edict (event with `event_type = dispatched`, with `related_event_id` pointing at the decision, and a corresponding row in `messages` if it lands in a worker session)
- the dispatch envelope (§13) - hub-internal record of what was rendered, how it was confirmed, and what response is expected

Same dispatched outcome. Different *memory*. The richer artefact matters for audit, the Overseer's own learning, and cross-session reasoning.

The events table is not just a logging table; it is the substrate that makes the Overseer *be* a continuous entity rather than a fresh chatbot per session.

### What this collapses

- **Issue #18 (cross-session memory)** becomes "the Overseer's saved-filter views over the events table."
- **Issue #14 (controlplane / overseer)** becomes "the Overseer IS the controlplane, with voice as its native UI."
- **Issue #11 (per-session scratchlist)** becomes the operator intent capture contract (§15) - intent items keyed to a session via `related_session_id`.
- **Issue #19 (channels)** becomes "external sources emit into events as `source_kind=channel`, surfaced via saved filters."

---

## §1 Worker event taxonomy

Workers must emit events with consistent semantics. Without a shared taxonomy, the Overseer is left interpreting tea leaves.

**Emission mechanism.** Event emission is implemented as a **prompted event-emission contract**: HAPI instructs the underlying agents (Cursor / Claude / Codex / etc) via the agent-instruction surface to emit structured events at specific moments. This is a *prompt-level contract* enforced by HAPI, not a code-level API on the agent side. The name deliberately avoids "prompt injection," which already means hostile prompt contamination in security usage and would mislead reviewers. Three consequences flow from this:

1. **Best-effort emission.** LLM compliance with prompted contracts varies by model and over time. The hub must validate defensively.
2. **Hub-observed fallback.** When a worker fails to emit an expected event (no `completed` despite the task being done, no `stale` despite 40 minutes of silence, no `tool_result` despite an obvious tool call), the hub synthesizes the event from observable signals. The synthesized event carries `source_kind = system` with `provenance` noting "hub-inferred from observable signal X."
3. **Iteration via prompt phrasing.** The taxonomy doc IS the prompt content (or near it). Compliance is A/B-testable. The contract evolves via prompt iteration plus model upgrades, not code rollout.

### Worker event wire format

Events are emitted by workers as **sentinel-delimited JSON blocks** in their normal output stream. Worker-visible prose outside the sentinel boundaries is never parsed as events, even if it looks structured. This protects both directions: the worker can talk about events in prose without accidentally emitting one, and the hub can ignore the vast majority of worker output cheaply.

- **Sentinels**: `<!--HAPI_EVENTS_BEGIN-->` and `<!--HAPI_EVENTS_END-->` framing a single JSON block. Anything outside the sentinels is treated as ordinary worker output.
- **Block shape**: one JSON object containing `schema_version` (integer, currently `1`) and `events` (array of one or more event objects). Multiple events in one block are common - workers naturally emit several at task end (`completed` + `commit_pushed` + a `risk_detected` flag).
- **Validation**: malformed JSON, missing required fields, or unknown `event_type` values trigger a `validation_error` event written by the hub with `source_kind = system` and the malformed payload preserved in `payload_json` for debugging. The original worker output is retained verbatim in the session transcript regardless of validity.
- **Required fields per event**: `event_type`, `summary`. All other fields default per taxonomy.
- **Coercion**: missing `attention_candidate` defaults per taxonomy (see table below). Missing `severity` defaults to 1. Missing `confidence` defaults to null (unknown).

Example block as the worker would emit it:

```text
<!--HAPI_EVENTS_BEGIN-->
{
  "schema_version": 1,
  "events": [
    {
      "event_type": "blocked",
      "summary": "CI auth failed on push; GitHub returned 403",
      "attention_candidate": 1,
      "severity": 4,
      "dedupe_key": "github-auth-ci-fail",
      "artifact_refs": [
        {"kind": "log_url", "url": "https://github.com/.../runs/123", "source": "tool_output"}
      ]
    }
  ]
}
<!--HAPI_EVENTS_END-->
```

The wire format is deliberately verbose and human-readable rather than compact. Workers are LLMs; cost is in token-count for prompted contract instructions, not in transport bandwidth. Verbose-and-clear beats compact-and-cryptic for emission compliance.

### Event type enum

Proposed enum for `event_type`:

| Type | Meaning | Default `attention_candidate`? |
|---|---|---|
| `progress` | Routine forward motion | false (mechanical) |
| `tool_call` | Worker invoked a tool | false (mechanical) |
| `tool_result` | Tool returned | false (mechanical) |
| `commit_pushed` | Worker pushed a commit | true (low priority) |
| `pr_opened` | Worker opened a PR | true |
| `needs_decision` | Worker waiting on operator judgement | true (high priority) |
| `blocked` | Worker can't proceed | true (high priority) |
| `risk_detected` | Worker thinks the operator should know | true |
| `approval_requested` | Worker wants explicit go/no-go | true (high priority) |
| `failed` | Task failed | true |
| `completed` | Task done | conditional on flags - see below |
| `heartbeat` | Worker still alive | false (mechanical) |
| `convo_turn` | Operator-Overseer conversation segment | false (memory-bearing; substrate for replay, not inbox) |
| `decided` | Operator made a decision in convo | false (memory-bearing; durable audit, not re-surfaced) |
| `dispatched` | Edict sent to a worker | false (memory-bearing; audit of the dispatch itself, not an inbox item) |

**`completed` enrichment.** A `completed` event is NOT automatically low-attention. The same `event_type = completed` can mean any of:
- "Done, nothing needed, FYI"
- "Done, review this PR"
- "Done, deploy is ready"
- "Done but revealed a new issue"
- "Done; I claim success but tests failed"
- "Done with a risky outcome"

Rather than splitting `completed` into four subtypes (combinatorial mess - what about completion that's review-needed AND risky AND has an artifact?), `completed` events MUST set the resolving flags:

| Field | When set |
|---|---|
| `operator_action_required` | True if any human action is expected (review, deploy approval, follow-up decision) |
| `artifact_refs` | Non-empty if a deliverable exists (PR, commit, file, deploy ID, screenshot, URL) |
| `risk_detected` | True if a caveat is being flagged |
| `confidence` | Worker's self-rated confidence in the success claim |

A completion that's reviewable + risky + has a PR is:
```
{
  event_type: "completed",
  operator_action_required: true,
  artifact_refs: [{kind: "github_pr", url: "...", title: "..."}],
  risk_detected: true,
  confidence: 0.7,
  summary: "Migration applied; tests pass but one flaky retried 3 times - want a closer look"
}
```

Composable. No enum explosion. Routing rules can derive inbox-promotion from any combination.

Additional fields (all in the schema above):

- `severity` - 1-5; tunes default priority within type.
- `operator_action_required` - boolean; salience starts here.
- `risk_detected` - boolean; flagged caveat.
- `confidence` - 0.0-1.0; worker may be unsure.
- `artifact_refs` - JSON array; handles to things produced.
- `dedupe_key` - prevents the same blocker becoming 9 urgent items.
- `expires_at` - some events stop mattering after a moment.
- `provenance` - where the claim came from (worker / tool output / repo / test run / hub-inferred).
- `idempotency_key` - needed for safe dispatch/retry.

The schema can evolve. **Bad event semantics will poison the Overseer.** Get the taxonomy right early.

---

## §2 Worker state model

The Overseer needs to know when a worker is "wedged," "mid-merge," "blocked," "wrong-context." Those terms need definitions, not vibes.

Proposed states:

- `idle` - alive, no current task
- `working` - actively processing a turn
- `waiting_on_operator` - turn ended, expecting operator response
- `waiting_on_external` - blocked on CI, third-party API, etc.
- `blocked` - genuinely stuck, operator needed
- `failed` - last turn errored out
- `complete` - finished assigned task
- `stale` - no output for N minutes (configurable)
- `unknown` - hub-observed state ambiguous

Plus three *views* of state that must be distinguished:

| View | Source | Authority |
|---|---|---|
| `worker_reported_state` | what the worker says | strongest signal, but may lie or be silent |
| `hub_observed_state` | session activity (last message, heartbeat, process check) | factual but coarse |
| `overseer_inferred_state` | combination + heuristics ("probably stuck") | useful but explicitly uncertain |

When the Overseer says "peer-X is wedged," the operator should be able to ask "are you sure?" and get the underlying signals: "Worker reports `working`, no output for 41 minutes, last tool call `npm install` returned no exit code." Otherwise the Overseer confidently misreports `npm install` doing its usual interminable thing as "wedged" and the operator stops trusting it.

---

## §3 Inbox item model

Inbox items are NOT the same shape as events. Twelve events may collapse into one inbox item (e.g., five workers report the same upstream dependency failure → one fleet-level inbox item).

```
inbox_items(
  id                  INTEGER PRIMARY KEY,
  status              TEXT NOT NULL,        -- new | surfaced | deferred | snoozed | resolved | obsoleted | held
  priority            REAL NOT NULL,        -- computed effective_priority
  base_priority       REAL NOT NULL,
  aging_factor        REAL,
  time_criticality    REAL,
  decay_after         INTEGER,              -- ts after which decay kicks in
  reason_for_priority TEXT,                 -- human-readable explanation
  source_event_ids    TEXT,                 -- JSON array; events that contributed
  related_inbox_ids   TEXT,                 -- JSON array; merged-from / supersedes
  artifact_refs       TEXT,                 -- JSON array; aggregated from source events
  suggested_action    TEXT,                 -- Overseer's proposal
  deadline            INTEGER,              -- ts if applicable
  operator_feedback   TEXT,                 -- explicit thumbs / corrections
  surfaced_at         INTEGER,
  resolved_at         INTEGER,
  snoozed_until       INTEGER,
  attention_class     TEXT NOT NULL,        -- live | quiet | focus | digest | panic
  breakpoint_class    TEXT,                 -- immediate | conversation_pause | typing_stop | scheduled
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
)
```

Status transitions: `new -> surfaced -> resolved | deferred | snoozed -> resurfaced -> ...`. Or `new -> obsoleted` if newer events supersede. Or `new -> held` if the operator parks it for later.

This keeps the events table immutable-ish (append-only audit) while the attention layer evolves freely. Inbox items can be reshaped, repriorized, merged without touching the events history. Artifact refs aggregate from contributing events so an inbox item carries handles to the things it's about.

---

## §4 Edict / action lifecycle

When the Overseer dispatches, the edict has a lifecycle:

```
proposed -> confirmed -> dispatched -> accepted -> in_progress -> completed
                              │
                              └─► rejected | failed | timed_out | superseded
```

Action-tracking fields (live on the dispatch envelope, §13):

- `supersedes_event_id` - this action replaces a prior one
- `cancels_event_id` - this action explicitly cancels a prior one
- `retry_of_event_id` - this is a retry
- `requires_confirmation` - does this need explicit operator OK
- `confirmation_source` - voice / UI / typed / standing-order
- `confirmed_by` - operator identity (single-op for now, but model for it)
- `confirmed_at` - timestamp

Voice makes accidental duplication easier (realtime layer hiccups, operator says "yes" twice). The `idempotency_key` on dispatch envelopes combined with the dispatched-only-once invariant prevents Schrödinger's task.

---

## §5 Prioritization & salience feedback loop

> **Lives in the prioritization doc** (`2026-06-03-overseer-prioritization.md`). The salience loop, base-priority defaults, implicit/explicit feedback signals, and v0 simplifications are scoring-engine concerns, not implementation-contract concerns.

## §6 Replay / evaluation harness

> **Lives in the prioritization doc**. The replay/evaluation harness exists to validate the prioritization engine, the persona, and the one-boss invariant; it sits alongside the scoring loop logically.

---

## §7 Memory promotion rules

Voice conversations become memory, but not all conversation should auto-promote. Categories:

| Memory class | Lifetime | Promoted by |
|---|---|---|
| `transcript` | 14-day default; gitignored | every voice convo (raw) |
| `decision` | indefinite | explicit operator marker OR confirmed dispatch with rationale |
| `preference` | indefinite | explicit operator command ("remember that I always X") |
| `standing_order` | scoped time-bound | explicit operator command, with revocation |
| `fact` | indefinite | explicit operator assertion ("the prod cluster is at IP X") |
| `intent_item` | until resolved | operator intent capture (§15) |
| `audit_event` | indefinite | every dispatched edict, confirmed action, escalation |

**Default for transcripts: expires after `TRANSCRIPT_RETENTION_DAYS`, never auto-promoted to decision or preference without explicit operator marker.** Otherwise the Overseer remembers some half-joke from 2am and uses it like corporate policy six months later.

**Storage policy after transcript expiry.** Raw transcript payloads expire on the `TRANSCRIPT_RETENTION_DAYS` schedule. Durable `convo_turn` events retain only their summary, timestamps, participants, and links to promoted decisions/intent items after the raw transcript is gone; the `payload_json` of those events is nulled (or replaced with a redaction marker carrying the original byte count for audit). `decided` and `dispatched` events are indefinite by default (they are the audit substrate, not the chat record). Replay harnesses that need raw transcript data run against non-production captured fixtures, not against indefinite production transcript storage; `decided` and `dispatched` events alone are sufficient for the one-boss invariant test (ADR-001 §"Invariant test") because the test reads worker-facing rendered instructions, not Overseer-side convo prose.

---

## §8 Security and command authentication

Voice dispatch is dangerous because speech is ambiguous, accidental, and spoofable. One YouTube clip yelling "yes send it" should not become the very stupid Skynet origin story.

Required:

- **Authenticated client attachment**: only operator-authenticated clients can attach to the Overseer voice session.
- **Device trust tiers**: desktop browser > authenticated mobile-web > paired bluetooth. Lower-trust devices restricted to read-only by default.
- **Voice command confirmation for risky actions**: destructive or external actions require an explicit second confirmation, read-back-before-dispatch ("about to send 'delete branch X' to peer-Y, confirm out loud or tap to confirm").
- **Wake-word distinct from action verbs**: "Overseer, dispatch" rather than just "dispatch."
- **Background-audio detection**: skip command interpretation if mic input wasn't operator-voice in last N seconds (voice-print check, optional).
- **Voice command kill-switch**: ability to disable voice *commands* while leaving voice *discussion* enabled - so the operator can shoot the shit without risk of accidental dispatch.
- **Audit trail**: every confirmed dispatch records `confirmation_source`, `confirmed_by`, `confirmed_at`, plus the audio clip hash for after-the-fact verification.

Defaults for first build: voice convo enabled, voice dispatch **opt-in per device** and **disabled by default on mobile-web/bluetooth**.

---

## §9 Attention budget modes (bounded deferral)

> **Lives in the prioritization doc.** Bounded deferral and the five modes (`live` / `quiet` / `focus` / `digest` / `panic`) are scoring-and-delivery concerns that fit with the prioritization loop.

---

## §10 Channel priority policy

External channels (issue #19) emit into events as `source_kind=channel`. They must NOT bypass the Overseer unless explicitly configured.

For each channel type, the operator configures:

| Field | Example |
|---|---|
| `default_event_type` | `needs_decision`, `progress`, etc. |
| `default_severity` | 1-5 |
| `default_attention_candidate` | true / false (default false = captured-only) |
| `dedupe_window` | time window for collapsing repeated emissions |
| `routing` | `direct-to-operator` / `via-overseer` / `captured-only` / `disabled` |

Routing semantics:

- `direct-to-operator`: skips Overseer prioritization; surfaces directly via push / banner / OS notification per channel policy.
- `via-overseer`: emits into events as `attention_candidate = 1`, flows through normal Overseer prioritization.
- `captured-only`: stored and queryable, no proactive surfacing. Operator can ask "any DMs?" and the Overseer answers; nothing pushes.
- `disabled`: do not ingest; channel is wired but emits nothing into the events table. Useful for muting noisy integrations without removing them.

Note: this contract intentionally avoids "suppressed" wording for channel events for the same reason the framing doc avoids it for attention-qualified items - `captured-only` is *not-promoting-to-attention*, not deletion or hiding.

Examples:

- GitHub issue created on watched repo → `event_type=needs_decision`, severity=2, routing=`via-overseer`
- CI failed on a worker's PR → `event_type=blocked`, severity=4, routing=`via-overseer`, dedupe_window=30min
- Calendar event imminent (15 min) → `event_type=needs_decision`, severity=4, routing=`direct-to-operator` (calendar reminders shouldn't wait on inbox prioritization)
- Discord DM → `event_type=progress`, severity=1, routing=`captured-only` (`attention_candidate=0`; operator can ask "any DMs?" but no proactive surfacing)
- PagerDuty noise during maintenance window → routing=`disabled` (temporarily)

Without explicit policy per channel, channel integration turns into notification soup.

---

## §11 Provenance for Overseer speech

The Overseer should not just say "Peer 15 is blocked." It should be able to reveal, on request:

> "Peer 15 reported a blocker 12 minutes ago after the test suite failed twice. No new output since. Source: `worker_reported_state` from session `cfc4f219`, last event ID 84231."

Every surfaced claim needs a source trail. Implementation: when the Overseer composes inbox-item presentations, include hidden citations (event IDs); operator can ask "show your sources" and the Overseer reads them back.

This earns trust **by showing receipts**, not by sounding competent. Trust-by-personality is fragile and breaks the first time the Overseer confabulates a fact.

---

## §12 Cost / latency strategy

The Overseer cannot run a giant expensive model on every event. Tier the workload:

| Layer | Model / logic | Frequency |
|---|---|---|
| Event classification (`attention_candidate` 0 vs 1) | Rules + tiny model | every event |
| Salience scoring | Cheap model + heuristics | every candidate |
| Conversational turn | Realtime voice model | per operator utterance |
| Deep fleet analysis ("what's the state of peer X over the last day") | Heavier model, summoned | on demand |
| Persona / response composition | Whatever the voice model uses | per turn |

Otherwise the first version costs absurd money or lags like a Windows 95 printer driver.

---

## §13 Hub-internal dispatch envelope

The one-boss principle (ADR-001) says workers never know about the Overseer. But the *hub* needs to know everything about a dispatch for audit, provenance, routing, and Overseer-side reasoning. That information lives in a **hub-internal envelope** wrapping every Overseer-mediated dispatch - never exposed to the receiving worker.

**Envelope scope at MVP: Model B.** Only Overseer-originated and standing-order-originated dispatches get envelopes. Direct operator messages (typed or PTT-dictated straight into a worker session) remain in the existing `messages` flow without envelope wrapping. Rationale: less invasive migration, no risk to the existing HAPI message path, MVP scope tightens. The trade-off is that direct vs Overseer-routed instructions live in slightly different audit shapes, which is acceptable for MVP. **Model A** (all worker instructions normalized through the envelope system, uniform audit + replay + response correlation) is the future-state target and is reserved for a later uniform-audit pass.

```
dispatch_envelope(
  id                       INTEGER PRIMARY KEY,
  ts                       INTEGER NOT NULL,
  origin                   TEXT NOT NULL,        -- overseer | standing_order
                                                 --   (Model B: direct operator messages are NOT enveloped at MVP.
                                                 --   Model A reserves a future operator_direct value.)
  operator_confirmed       INTEGER NOT NULL,     -- bool
  confirmation_source      TEXT,                 -- voice | ui_button | typed | standing_order_id
  confirmation_event_id    INTEGER REFERENCES events(id),
  rendered_instruction     TEXT NOT NULL,        -- what the worker actually receives
  rationale                TEXT,                 -- Overseer's internal "why I drafted this"
  related_event_ids        TEXT,                 -- JSON array of contributing events
  related_inbox_item_id    INTEGER REFERENCES inbox_items(id),
  priority                 INTEGER,              -- carries forward for response routing
  expected_response_type   TEXT,                 -- ack | action | question | artifact | none
  target_session_id        TEXT NOT NULL REFERENCES sessions(id),
  message_id               TEXT,                 -- the messages.id row created on dispatch
  idempotency_key          TEXT NOT NULL,        -- prevents double-fire
  status                   TEXT NOT NULL,        -- queued | dispatched | acknowledged | superseded | failed
  dispatched_at            INTEGER,
  acknowledged_at          INTEGER
)
```

**What the worker sees:** `messages.body = rendered_instruction`, `messages.role = 'user'`, no source flag exposing Overseer origin. From the worker's reading, the operator sent it. The envelope is not visible at the worker layer.

**What the hub sees:** full envelope, full provenance, full audit trail. Available for replay, for "show your sources" voice commands, for the Overseer's memory.

**What this enables:**
- The Overseer can normalize responses for its own consumption ("peer-15 just answered the dispatch I sent at 14:22; here's the answer in the context of that question").
- The replay harness can re-run dispatch sequences and verify the one-boss invariant: the rendered instruction in the worker's `messages` row never contains Overseer attribution. (ADR-001 §"Invariant test".)
- Audit queries like "every action taken on peer-15 in the last week, by source" stay answerable.
- Standing orders (Stage 2) record `origin = standing_order` with `operator_confirmed = true` (the standing order itself was the confirmation), preserving full attribution even when the operator wasn't in the conversational loop at dispatch time.

Cross-reference: §1 (event taxonomy) emits `dispatched` events that link to envelope rows via `idempotency_key`; §4 (action lifecycle) operates on dispatch envelopes for status transitions.

---

## §14 Contradiction handling

The Overseer will routinely face conflicting claims:

- Worker reports tests pass; CI says fail.
- Worker reports `blocked`; hub-observed state shows recent tool calls (worker still producing output).
- Operator says "ship it"; standing-order policy says "never deploy after 5pm."
- Two workers propose incompatible fixes for the same blocker.

Without a contradiction policy, the Overseer either picks confidently (and lies) or picks tentatively (and adds latency to every interaction). Both are worse than naming the conflict.

The four-step policy:

1. **Prefer direct tool/system evidence over worker summary.** CI status > worker self-report. `git status` > worker's "I committed it." Tool output is closer to ground truth than the worker's narration of tool output.
2. **Preserve uncertainty.** If two sources disagree and neither is authoritative, the Overseer's internal state records both; it does NOT collapse to a confident single claim.
3. **Surface contradictions that affect routing or action.** If a contradiction matters for the operator's next decision, the Overseer raises it: "Peer-15 says tests pass; CI says fail - which signal are we acting on?"
4. **Never synthesize confident output from conflicting inputs.** The failure mode is the bullshit cannon: confidently presenting an averaged-or-confabulated answer that ignores the underlying disagreement. The Overseer's job is to surface the conflict, not to paper over it.

Implementation: the events table already supports `source_kind` and `confidence` fields per event. The Overseer's reasoning layer checks for conflicting claims about the same `(related_session_id, subject)` tuple before composing responses. When conflict is detected, the response template branches to "raise conflict" rather than "answer confidently."

This is trust-critical. Confident synthesis of conflicting data is how these systems become bullshit cannons.

---

## §15 Operator intent capture

The operator often says things in conversation that are **neither edicts nor mere transcript**:

- "We probably need to revisit the deployment shape."
- "Park this, but I don't want to lose it."
- "Ask me about this after the current PR lands."
- "This is maybe a future issue, not now."
- "Remind me that peer 7's approach smelled wrong."
- "I want to think about this more before I commit."

These are **operator intent fragments**: held thoughts that may or may not become inbox candidates or edicts later, depending on conditions the operator hinted at. They originate from *conversation*, not from *fleet activity* - distinct from held inbox items, which originate from worker events and are parked by the operator.

```
intent_items(
  id                       INTEGER PRIMARY KEY,
  summary                  TEXT NOT NULL,
  full_text                TEXT,
  source_convo_event_id    INTEGER NOT NULL REFERENCES events(id),
  trigger_condition        TEXT,                 -- natural-language: "after current PR lands", "tomorrow morning", null
  trigger_type             TEXT,                 -- time | event_pattern | manual | null
  trigger_ref              TEXT,                 -- ts | event_id pattern | null
  related_session_id       TEXT REFERENCES sessions(id),
  status                   TEXT NOT NULL,        -- held | promoted_to_inbox | promoted_to_edict | discarded
  promoted_to              INTEGER,              -- inbox_items.id or dispatch_envelope.id
  created_at               INTEGER NOT NULL,
  resolved_at              INTEGER
)
```

Distinction from held inbox items:

| | Held inbox item | Intent item |
|---|---|---|
| Originates from | worker event | operator convo |
| Default surfacing | priority + aging in the queue | trigger-condition firing |
| Lifecycle | resolved on dispatch / snooze / obsoletion | promoted to inbox or edict, or discarded |

Operator commands that surface around intent items:

- *"Capture this as intent."* → creates an `intent_item` with the operator's convo segment as source.
- *"Promote that intent to an inbox candidate."* → creates an `inbox_item` with the intent's summary; intent's status moves to `promoted_to_inbox`.
- *"Promote that intent to a dispatch."* → drafts a `dispatch_envelope`, awaits confirmation; intent's status moves to `promoted_to_edict` on dispatch.
- *"What intents am I holding?"* → lists held intents with their trigger conditions.
- *"Drop that intent."* → marks `discarded`.

This absorbs issue #11 (per-session scratchlist) at fleet level: scratch items in this model are intent items keyed to a specific session via `related_session_id`. The "stuff in queue is getting read and dealt with but not removed from queue" bug noted on session 7d706262 falls out naturally - intent items have explicit status transitions that prevent the half-resolved-half-pending state.

---

## Autonomy gates (related, not a contract)

The naive "write-with-rollback" framing was rejected: **rollback is fantasy once work has been done.** Agents will have committed, pushed, sent, called - rolling back is not always easier than rolling forward. The actual safety mechanism is **gate-before-action**, not undo-after-action.

The autonomy stages depend on the contracts above:

### Stage 0 (target for first build) - Read-only Overseer

Can: read events stream, query worker state via HAPI API, surface things in voice convo, answer fleet questions, recommend actions.
Cannot: dispatch, spawn, modify state.
Failure mode if wrong: operator gets a bad recommendation, ignores it. Cheap.

### Stage 1 (next) - Confirm-per-action dispatch

Overseer proposes actions in voice convo; operator greenlights ("yes, send it"); Overseer drafts a dispatch envelope (§13); hub renders and posts the operator-attributed message into the target worker session. Every dispatch explicit in the conversation. Operator confirmation captured in events (`confirmation_source`, `confirmed_by`, `confirmed_at`).
Failure mode if wrong: operator says no. Cheap.

### Stage 2 (aspirational, well after) - Standing-order autonomy within scope

Operator says, in conversation, "for the next hour, if a worker reports a flaky test, just tell them to retry once before pinging me." Overseer acts within that scope without re-asking. All actions audit-trailed. Dispatches still arrive at workers operator-attributed (one-boss principle holds; the standing order IS operator pre-authorization). *No rollback claim made* - if the standing-order call was wrong, recovery is forward-fix.
Failure mode if wrong: real damage possible. Scopes must be narrow, time-bounded, voice-revocable.

### Stage 3 (out of scope for first build) - Open-loop heartbeat autonomy

Overseer wakes on a timer, takes actions the operator hasn't pre-authorised. **The operator explicitly flagged this as a bridge too far** - AGI-adjacent intent-alignment requirement. Mentioned for completeness; not on the roadmap.

---

## References

### HAPI code

- `hub/src/web/routes/machines.ts:25` - `POST /api/machines/:id/spawn` (peer-spawn primitive)
- `hub/src/web/routes/messages.ts:51` - `POST /api/sessions/:id/messages` (message post)
- `shared/src/apiTypes.ts:177` - `SpawnSessionRequestSchema` (spawn shape)
- `shared/src/modes.ts:10` - `AGENT_FLAVORS` (claude, codex, cursor, gemini, kimi, opencode)
- `hub/src/store/messages.ts`, `sessions.ts` - existing store layer to model the events table on

### Companion docs

- `2026-06-03-overseer-framing.md` - concept, model, voice-above-workers, decision channel.
- `2026-06-03-overseer-prioritization.md` - prioritization contracts (§5 scoring loop, §6 replay harness, §9 attention budget); prior art.
- `2026-06-03-overseer-build-sequence.md` - Steps 1-6 (incl. 2.5 and 2.75 replay harness), MVP acceptance bar, non-goals, risks by phase.
- `docs/adr/0001-worker-facing-attribution-one-boss.md` - one-boss principle ADR; load-bearing for §13.
