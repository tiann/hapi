# Peer agent offering (product + API spec)

**Status:** Design (fork-only)  
**Owner:** Operator product thread (imported from session `895c0a1b-…`)  
**Related:** Resume-race work (#728) is a separate implementation peer — do not conflate.  
**Parent context:** [Session 895c0a1b](https://hapi.tail9944ee.ts.net/sessions/895c0a1b-2eb0-4309-a805-d458ed2aefb3)

---

## 1. Glossary (canonical names)

| Term | Meaning | Where it shows up |
|------|---------|-------------------|
| **Peer agent** | A **sibling** hub session: own runner process, own sidebar row, own transcript. Started deliberately by the user (or automation) via hub spawn — not a hidden attach. | Session list, notifications, voice "which session?" |
| **Subagent** | Child work **inside** one session: agent invokes `Task` / `Agent` (Claude) or Codex `spawn_agent`. Same session id; nested tool cards. | Tool trace only (`web/src/chat/subagentTool.ts`) |
| **Ghost session** | A session row that exists in HAPI **without** the operator intending a new context (e.g. resume race, duplicate spawn, import merge). **Anti-pattern** for peer spawn — peers must be **visible and intentional**. | #440 / #728 class bugs — not this feature |

**Rule of thumb:** If it gets its own row in the session list on purpose, it is a **peer**. If it only appears inside tool cards, it is a **subagent**. If it appears in the list but nobody meant it to, it is a **ghost**.

**Graph context (XR):** Peers are **sibling edges** between session nodes under a project branch; subagents are **in-session** folds. See `docs/operator/xr/work-graph-and-visualization.md` (operator-only).

---

## 2. Product principles

1. **Name the capability** — UI and docs say **Peer agent** (verb: "Move to peer" / "Spawn peer", noun: "peer").
2. **Not a ghost** — Spawn must be an explicit affordance; first message and title make lineage obvious.
3. **First-class relocation** — The primary story is not "empty peer with a link back" but **"this conversation belongs in its own session"**: move the relevant transcript slice to the peer, leave a single tombstone in the parent.
4. **Trivial regret** — Operator realizes mid-chat they should have split earlier; one confirm moves scope without copy-paste archaeology.
5. **Message 1 contract (fresh peer)** — When *not* relocating history, peer still gets task + parent URL + optional issue (§7.5).
6. **Title** — Human-readable name in the list; include `#NNN` when `githubIssue` is set. Do not rely on worktree folder names alone.
7. **Do not overload Send** — Cursor IDE "multitask" = in-session subagents; HAPI **Peer** = fork to another session (separate control).
8. **Agent salience** — Agents may **suggest** relocation when scope has clearly diverged; operator always confirms (no silent auto-fork).

### Modes compared

| Mode | Parent transcript | Child transcript | Use when |
|------|-------------------|------------------|----------|
| **Relocate** (default) | Tombstone only for moved range | Moved messages + optional handoff line | "I should have been in another chat" |
| **Fresh peer** | Unchanged | Template intro + task only | Parallel work, same topic zero history |

---

## 3. UX rollout (recommended)

### v1 — Move conversation to peer (first-class)

**Primary entry points:**

1. Session menu → **Move conversation to peer…**
2. Composer → **Peer** (fork) — opens same flow with draft prefilled
3. Outline / message action → **Move from here…** (sets `fromSeq` to selected message)
4. Agent suggestion card → **Move to dedicated session** (one tap, same API)

**Panel (sheet / modal):**

| Field | Default | Notes |
|-------|---------|-------|
| **What moves** | "From here" = last user message in outline, or full thread if &lt;3 turns | Radio: *This message onward* / *Entire conversation* / *Pick in outline* |
| Topic title | Infer from first moved user line or agent `suggestedTitle` | Becomes peer session name |
| Issue | Parse `#(\d+)` from selection | Optional |
| Task (child) | "Continue this work." | Shown in relocate handoff only if no moved user text |
| Directory / machine / agent | Copy parent | Editable |
| Worktree | Off | Opt-in |

**Primary CTA:** **Move to peer session** (stronger than "Spawn peer" — implies relocation).

**On success:**

- Navigate to **child** (recommended default — operator continues where the work went).
- Parent shows **one** tombstone block (§4) replacing the relocated slice in the UI.

**Empty peer spawn** remains available as secondary: "Start empty peer linked to this session" (fresh mode).

### v2 — Agent suggestion surface

When the agent (or hub heuristic) fires a suggestion:

- Inline card above composer: *"This looks like a separate topic. Continue in a dedicated session?"*
- Actions: **Move to peer** · **Not now** · **Don't ask again this session**
- Optional: agent proposes `fromMessageId` — panel preselects that fork point.

### v3 — Slash + automation

- `/peer move` — relocate from last user message
- `/peer [#728] …` — fresh or relocate with issue scope
- Scripts: `POST …/spawn-peer` with `relocate` block

### Explicit non-goals (v1)

- No composer-only spawn without confirmation panel (costly worktrees).
- No silent auto-relocate without operator confirm.
- No undo/re-merge in v1 (see §4.4).

---

## 4. Conversation relocation (spec)

### 4.1 Context window truth (read this first)

**Relocate without agent compaction is mostly cosmetic.**

| Layer | What relocate changes | What actually fills the model context |
|-------|----------------------|----------------------------------------|
| **HAPI hub DB** | `session_id` on message rows; parent tombstone in UI | Nothing — not the inference transcript |
| **CLI agent (Claude/Codex/Cursor)** | Nothing by default | Native thread / SDK history — **unchanged** |

The status bar `ctx 142k/200k (71%)` comes from agent **`token-count`** / Claude `compact_boundary` events, not from HAPI row count.

**Implication:** Peer relocate is only worth building for **context pressure** if we pair it with **parent-side compaction** (and child-side bootstrap — §4.7). Tombstone + DB move = sidebar hygiene + human clarity; **token relief = `/compact` (or flavor equivalent) on the parent after relocate.**

**Existing compaction hooks in this repo:**

- Claude: user `/compact` → SDK compaction → `compact_boundary` / `microcompact_boundary` events (`cli/src/claude/claudeRemote.ts`, `web/src/chat/normalizeAgent.ts`).
- Codex: `/compact` + automatic `context_compacted` / `compactThread` on overflow (`cli/src/codex/codexRemoteLauncher.ts`).
- HAPI cannot delete arbitrary invoked transcript rows today (`DELETE` is queued-only).

### 4.2 Operator story

> "I was debugging payments in this session, then we went deep on peer agents for an hour. I want that hour in its own session — this chat should just say we moved **and my parent agent should stop carrying that hour in context.**"

### 4.3 Parent session after relocate

**Remove** from parent UI (and parent message queries): every message with `seq` in `[fromSeq, toSeq]` inclusive.

**Insert** one hub-authored **tombstone** at the position of `fromSeq` (seq compaction strategy below).

**Tombstone content** (web renders as `agent-event` or dedicated block):

```text
Conversation continued in a dedicated session.

→ Peer: #728 Peer agent relocation spec
   https://{origin}/sessions/{peerSessionId}

12 messages moved (May 30, 14:02–14:47).
```

**Parent agent context (required for v1 if we claim context value):** After relocate + tombstone, hub **must queue** a parent message the CLI treats as compaction:

```text
/compact The conversation about "{peerTitle}" was moved to a dedicated peer session: {peerUrl}.
That diverted thread is no longer in this context.

1) Summarize what remains relevant HERE (original session goal, decisions still active in this chat). Drop tool dumps and relocated detail.
2) Add a short **"Before the diversion"** recap — what we were discussing immediately before that topic started — so I can resume the earlier thread without re-reading the peer session. Label it clearly. Do not merge the peer topic back in.
```

The recap-in-compact is intentional: parent agent keeps a **re-entry ramp** for the pre-fork work without holding the full diverted transcript.

Flavor matrix:

| Flavor | Parent post-relocate action |
|--------|----------------------------|
| Claude | `/compact …` (supported — `parseSpecialCommand`) |
| Codex | `/compact` or `compactThread` RPC if hub exposes it |
| Gemini | `/compress …` (builtin in `shared/src/slashCommands.ts`) with same instruction body |
| Cursor | See §4.4.1 — product **has** summarization; HAPI **has not wired it** |

### 4.4.1 Cursor: capability vs HAPI wiring

**Remarkable but true in this repo:** `BUILTIN_SLASH_COMMANDS.cursor` is `[]` and `cursorRemoteLauncher.ts` passes every hub message straight to `agent -p … --resume …` with **no** `parseSpecialCommand` path (`cli/src/cursor/cursorRemoteLauncher.ts`).

**Underlying Cursor (product), not HAPI:**

- IDE + agent sessions support **automatic** context summarization near the window limit.
- Operators report a **`/summarize`** command (manual trigger) that compresses conversation context aggressively (~190k → ~1k per forum reports — quality varies).
- Same agent stack in CLI/SDK; compaction is **not** a Claude-only concept.

**Gap = integration**, not physics. v1 Cursor parent policy options (probe in dogfood):

1. **`/summarize` as message** — queue user text: `/summarize` + relocation instructions (§4.3 template adapted for summarize wording). If CLI honors it like IDE, parent ctx drops.
2. **Natural-language summarize** — if `/summarize` is ignored headless, send: *"Summarize this session per the following rules: …"* (weaker, model-dependent).
3. **Hub-generated recap only** — no native compact; inject structured recap user message (does **not** free window — **cosmetic** for Cursor until 1 or 2 works).

**Spec default for Cursor until proven:** attempt (1), fall back to (2), surface `parentCompact.reachedTarget: false` in API response. Do **not** claim parity with Claude until `token-count` / usage drops after relocate in E2E test.

**Follow-up issue:** add `cursor` builtins (`summarize`, `clear`?) + `parseSpecialCommand` parity in `cursorRemoteLauncher` mirroring Claude/Codex.

### 4.4 Post-peer compression policy (percentage)

Three **different** percentages — do not conflate:

| Knob | Meaning | Example |
|------|---------|---------|
| **`relocateTriggerMinPct`** (UX) | Show aggressive "move to peer" when parent ctx ≥ this | `70` → banner at 70% full |
| **`parentCompactTargetPct`** (outcome) | After relocate, **aim** for parent ctx ≤ this | `40` → after compact, want ~40% utilization |
| **`movedShareEstimatePct`** (analytics only) | Rough share of window in relocated slice | informational in confirm panel |

**`parentCompactTargetPct` is a goal, not a guarantee.** Compaction is agent-controlled; hub observes `token-count` / `compact` events and may:

1. Queue initial `/compact` with relocation-aware instructions (§4.3).
2. Wait for `compact_boundary` / `context_compacted` (timeout e.g. 120s).
3. If `contextSize / contextWindow > parentCompactTargetPct`, queue **one** follow-up: `/compact Further reduce context; peer session holds relocated work at {peerUrl}.`
4. If still above target, surface toast: *Parent context still {n}% — run /compact manually or archive this session.*

**Do not** implement hub-side "delete 60% of tokens" by stripping HAPI rows — that lying to the UI while the model still remembers.

**Optional v2 — `compactMode` on spawn-peer:**

```ts
parentContext?: {
  policy: 'compact' | 'compact_aggressive' | 'none'  // default 'compact'
  targetUtilizationPct?: number   // default 40
  maxCompactPasses?: number       // default 2
}
```

`compact_aggressive` adds: *"Treat relocated material as out of scope; prefer a short bullet summary under 800 tokens."*

### 4.5 Child session after relocate

1. Spawn peer (new runner).
2. **Move** rows: `UPDATE messages SET session_id = :peer WHERE session_id = :parent AND seq BETWEEN :from AND :to` (reuse seq renumbering rules from `mergeSessionMessages` when appending to non-empty child — for relocate, child starts empty).
3. Prepend optional hub **handoff** user message (only if moved slice has no recent user prompt):

   ```markdown
   **Relocated from:** {parentUrl}
   Continue the work from the messages below without re-asking for context already established.
   ```

4. Set metadata: `parentSessionId`, `spawnKind: 'peer'`, `relocatedFrom: { parentSessionId, fromSeq, toSeq, movedAt }`.
5. Run **parent** post-compact policy (§4.4) before returning success to web.

### 4.6 Child native context bootstrap

New peer runner starts **cold** — moved HAPI rows do not automatically become Claude/Cursor native history.

**v1 mitigation (required alongside relocate):**

- Hub builds **`relocatedContextDigest`**: deterministic extract from moved messages (last N user lines + last assistant summary line per topic, cap e.g. 8k chars) and prepends to child as first user message after the slice (or merges into handoff).
- **v1.1:** optional hub LLM summarize of moved slice (cost + latency) when digest &gt; cap.

Without digest, child peer has UI history but **model amnesia** — same class of bug as parent-only DB relocate.

### 4.7 Seq / DB mechanics (implementation note)

Today:

- `mergeSessionMessages` moves **all** messages between sessions (`hub/src/store/messages.ts`).
- `DELETE /messages/:id` only cancels **queued** (uninvoked) rows — no general transcript delete.

**Required:**

- `relocateSessionMessages(db, parentId, peerId, fromSeq, toSeq)` inside a transaction.
- `insertHubEventMessage(parentId, tombstonePayload)` — hub-only row, `invoked_at` set, does not enqueue to CLI (or enqueues a one-line "context relocated" user message if product requires CLI sync).
- Emit `messages-invalidated` on both sessions.

**Optional v1.1:** `messages.relocated_to` column for audit instead of hard delete (tombstone still shown; filter relocated rows from parent queries).

### 4.8 Fork point selection rules

| Rule | Behavior |
|------|----------|
| Default | From **last user message** backward through contiguous assistant/tool turns until previous user message OR start |
| Outline pick | `fromSeq` = selected message's seq |
| Entire thread | `fromSeq = 1` |
| Queued-only tail | Disable relocate until sent (or relocate only invoked rows) |
| Subagent noise | Tool cards inside range move with the slice (same as today they are part of session history) |

### 4.9 Undo (deferred)

Relocate is destructive for parent layout. v2 may offer **Undo (60s)** if peer has no new operator messages — reverse move + delete tombstone. Not v1.

---

## 5. Agent suggestion (salience + agency)

### 5.1 When agents should suggest

Agents (all flavors) should consider suggesting relocation when **most** apply:

- Topic pivot: new goal unrelated to session title / first user intent
- Depth: ≥N user turns on a sub-topic (default N=6) while parent had a different original goal
- Stack confusion: multiple concurrent "threads" in one chat (issue A vs issue B)
- Operator language: "actually let's…", "separate concern", "different PR"
- Long tool-heavy digression (implementation plan, unrelated refactor)

**Do not suggest** when: quick clarification, single follow-up, subagent already appropriate, or session is already a peer (`metadata.parentSessionId` set).

### 5.2 How suggestion manifests

**Preferred (v2):** CLI-exposed tool `hapi_suggest_peer_session`:

```ts
{
  reason: string           // one sentence, shown to operator
  suggestedTitle: string
  fromMessageId?: string   // hub message id
  confidence?: 'low' | 'medium' | 'high'
}
```

Hub stores pending suggestion on session (`agentState` or `metadata.pendingPeerRelocation`) and web renders **suggestion card** (§3 v2). Operator tap → same relocate panel pre-filled.

**Interim (v1):** Agent uses natural language + optional `AskUserQuestion` with options *Move to dedicated session* / *Stay here* — document in operator `AGENTS.md` prompt slice. Hub does not parse until tool exists.

**Hub heuristic (optional v1.1):** Offline scorer on outline (topic drift via title changes + user message embedding cheap proxy) — never auto-acts, only surfaces same card.

### 5.3 Prompt contract (operator fork)

Add to session-facing agent guidance (not upstream canon until product agrees):

```markdown
If the conversation scope has moved to a distinct topic that deserves its own session,
call hapi_suggest_peer_session (or ask the operator whether to move to a dedicated session).
Do not spawn peer sessions yourself; wait for confirmation.
```

### 5.4 Dismissal

- **Not now** — suppress suggestions for 30 minutes or until next user message (configurable).
- **Don't ask again this session** — set `metadata.suppressPeerSuggestions: true`.

---

## 6. UI copy (draft)

| Surface | Copy |
|---------|------|
| Menu item (primary) | **Move conversation to peer…** |
| Menu item (secondary) | **Start empty peer…** |
| Panel title | **Move to dedicated session** |
| Panel subtitle | Moves selected messages to a new session. This chat keeps a short note with a link. |
| Scope label | **What to move** |
| Primary CTA | **Move to peer session** |
| Success toast | **Conversation moved** — continue in peer |
| Tombstone (parent) | **Conversation continued in a dedicated session.** → {peer title} |
| Suggestion card | **This looks like a separate topic.** Continue in a dedicated session? |
| List badge (optional v1.1) | **peer** pill when `metadata.parentSessionId` set |
| Child header | **Continued from** {parent title} |

**Subagent education:** *Agents can run subagents inside this session (Task / spawn_agent). Those stay in this chat. Use **peer** when the whole conversation should split.*

---

## 7. API design

### 7.1 Today (manual orchestration)

Operators can already:

1. `POST /api/machines/:machineId/spawn` — body per `SpawnSessionRequestSchema` (`shared/src/apiTypes.ts`)
2. `POST /api/sessions/:id/messages` — `{ text }`
3. `PATCH /api/sessions/:id` — `{ name }` (`RenameSessionRequestSchema`)

`scripts/attach-agent-chat.ts` demonstrates rename after spawn; it does **not** implement peer lineage or first-message template.

### 7.2 Proposed: atomic peer spawn + relocate

```http
POST /api/sessions/:parentSessionId/spawn-peer
Authorization: Bearer …
Content-Type: application/json
```

**Request body** (`SpawnPeerSessionRequestSchema`):

```ts
{
  /** Default 'relocate'. */
  mode?: 'relocate' | 'fresh'

  /** Required for mode=fresh. Optional for relocate (handoff only). */
  task?: string

  githubIssue?: number
  name?: string

  /** Move transcript slice from parent → child (mode=relocate). */
  relocate?: {
    /** Inclusive. Required unless fromMessageId set. */
    fromSeq?: number
    /** Inclusive. Default: latest seq in parent. */
    toSeq?: number
    /** Alternative to fromSeq — hub resolves seq. */
    fromMessageId?: string
  }

  agent?: AgentFlavor
  model?: string
  modelReasoningEffort?: string
  effort?: string
  yolo?: boolean
  sessionType?: 'simple' | 'worktree'
  worktreeName?: string

  dryRun?: boolean

  /** Default { policy: 'compact', targetUtilizationPct: 40, maxCompactPasses: 2 } — 40% confirmed by operator. */
  parentContext?: {
    policy: 'compact' | 'compact_aggressive' | 'none'
    targetUtilizationPct?: number   // default 40
    maxCompactPasses?: number
    /** Cursor: try '/summarize' vs 'nl_summarize' vs 'recap_only'. */
    cursorCompactStrategy?: 'summarize_slash' | 'nl_summarize' | 'recap_only'
  }
}
```

**Response** (`SpawnPeerSessionResponse`):

```ts
{
  type: 'success'
  sessionId: string
  name: string
  parentSessionId: string
  mode: 'relocate' | 'fresh'
  relocated?: { fromSeq: number; toSeq: number; messageCount: number }
  tombstoneMessageId?: string
  firstMessageLocalId?: string
  parentCompact?: { passes: number; utilizationPctAfter: number | null; reachedTarget: boolean }
}
| { type: 'error'; message: string; code?: string }
```

**Hub transaction (relocate mode):**

1. Validate range (invoked messages only; `fromSeq <= toSeq`; not empty).
2. Spawn child session (§7.1 steps 1–3).
3. `relocateSessionMessages(parent, child, fromSeq, toSeq)`.
4. `insertHubTombstone(parent, { peerSessionId, name, fromSeq, toSeq, count })`.
5. Set child metadata (§7.3) + `relocatedFrom` record.
6. `renameSession(child, title)` — prefer first moved user line over `task` when relocating.
7. If `mode=fresh`, `sendMessage` with §7.5 template; if relocate, optional handoff line only when slice has no user message.
8. **Parent compact policy** (§4.4): queue `/compact …`, await compact events, optional second pass vs `parentCompactTargetPct`.
9. **Child digest** (§4.6): prepend relocated slice summary for native context.
10. Return ids + counts + `{ parentContextUtilizationPct?: number }`.

**Fresh mode** — same as prior spec: no relocate block; parent transcript untouched; §7.5 template required (`task` required).

### 7.3 Session metadata extensions

```ts
parentSessionId?: string
githubIssue?: number
spawnKind?: 'peer'
relocatedFrom?: {
  parentSessionId: string
  fromSeq: number
  toSeq: number
  movedAt: number
}
suppressPeerSuggestions?: boolean
pendingPeerSuggestion?: {
  reason: string
  suggestedTitle: string
  fromMessageId?: string
  confidence?: 'low' | 'medium' | 'high'
  suggestedAt: number
}
```

**Web event type** (add to `AgentEvent` in `web/src/chat/types.ts`):

```ts
| {
    type: 'conversation-relocated'
    peerSessionId: string
    peerTitle: string
    peerUrl: string
    messageCount: number
    fromSeq: number
    toSeq: number
  }
```

### 7.4 Title template

```
{prefix}{issueLabel}{taskSnippet}

prefix     = "Peer: "
issueLabel = githubIssue ? `#${githubIssue} ` : ""
taskSnippet = first line of task, trimmed, max 48 chars, ellipsis if truncated
```

Examples:

- `Peer: #728 Resume race — hub spawn vs CLI`
- `Peer: Document peer agent API`

If `name` provided in request, use as-is (still allow `#` in operator override).

After worktree creation, **do not** replace title with worktree folder name unless operator renames.

### 7.5 First message template (fresh mode only)

Hub builds `text` (markdown plain):

```markdown
You are a **peer agent** — a separate HAPI session forked from another session.

**Parent session (context home):** {parentUrl}
{issueLine}

**Your task:**
{task}

Work autonomously. If you need clarification, say so in this session. Do not assume the parent session sees your replies unless the operator switches sessions.
```

Where:

- `parentUrl` = `{publicOrigin}/sessions/{parentSessionId}` (hub config `HAPI_PUBLIC_ORIGIN` or derive from request `Origin` / `X-Forwarded-Host`)
- `issueLine` = `**GitHub issue:** #${n} (scope)\n` or empty

**Optional v1.1:** append one-line parent summary from `metadata.summary.text` if present (cap 200 chars).

### 7.6 Suggestion endpoint (v2)

```http
POST /api/sessions/:sessionId/peer-suggestion
DELETE /api/sessions/:sessionId/peer-suggestion   // dismiss
```

Body for POST (from CLI tool handler): `pendingPeerSuggestion` fields above.

### 7.7 Public origin

Peer links must work from phone/Tailscale/voice. Document env:

- `HAPI_PUBLIC_ORIGIN` (hub) — e.g. `https://hapi.tail9944ee.ts.net`

Fallback chain: env → request Origin → relative path only as last resort (bad for agents).

---

## 8. Acceptance criteria

### v1 — Move conversation (relocate)

- [ ] **Move conversation to peer…** relocates default slice; parent shows exactly one tombstone with link to child.
- [ ] Relocated messages **disappear** from parent thread and **appear** in child (same order, same content).
- [ ] Child `metadata.parentSessionId`, `spawnKind`, `relocatedFrom` populated.
- [ ] Operator lands in child after confirm (default).
- [ ] **Fresh peer** path still available; parent unchanged.
- [ ] Failed relocate rolls back (no tombstone without successful child + move).
- [ ] **Parent ctx:** after relocate, hub queues `/compact` (Claude/Codex); parent `token-count` drops materially or UI reports compact events.
- [ ] **Child ctx:** relocated digest message present so new peer is not amnesiac on first turn.
- [ ] Relocate with `parentContext.policy: 'none'` documented as **cosmetic-only** (sidebar tidy, no token promise).

### v1 — Spawn / lineage

- [ ] Child is a new sidebar row (not a ghost).
- [ ] Tombstone / child headers link to each other with correct `HAPI_PUBLIC_ORIGIN`.

### v1 — Subagent distinction

- [ ] Relocate does not nest under tool cards; subagents unchanged in parent for non-moved tail.

### v2 — Agent suggestion

- [ ] Suggestion card renders from `pendingPeerSuggestion` or tool; dismiss rules work.
- [ ] **Move** pre-fills panel from `fromMessageId` when provided.

### v2 — Composer **Peer** button

- [ ] Opens relocate panel; **Send** unchanged.

---

## 9. Friction mode (risks + falsification)

| Risk | Mitigation | Kill / measure |
|------|------------|----------------|
| CLI vs HAPI transcript split | Parent `/compact` + child digest mandatory for relocate | Track `parentCompact.reachedTarget`; if &lt;60% hit target, revisit policy |
| Compact not on Cursor | Flavor gate or summary-only fallback | Don't claim context relief on unsupported flavors |
| Wrong fork point | Outline pick + agent `fromMessageId` | &gt;10% relocates archived in 5m → UX review |
| Sidebar noise | Relocate reduces parent clutter | Same as before: empty peer archive rate |
| Mis-click relocate | Confirm panel shows message count + preview | Zero accidental full-thread moves in dogfood |
| Suggestion fatigue | Dismiss + suppress flags | &gt;50% suggestions dismissed → tune heuristics |
| Ghost vs peer | `spawnKind` + tombstone | Ghost = no tombstone, no `spawnKind` |

**Cheapest falsification:** hub script: spawn + move seq range + insert tombstone JSON; dogfood one real topic pivot.

---

## 10. Implementation map (for upstream PR slicing)

| Slice | Repo areas | Notes |
|-------|------------|-------|
| A — Relocate store | `hub/src/store/messages.ts`, migrations if needed | `relocateSessionMessages`, tombstone insert |
| B — spawn-peer route | `sessions.ts`, `syncEngine`, `apiTypes.ts` | relocate + fresh modes |
| C — Web relocate UX | `SpawnPeerSheet`, outline action, `presentation.ts` event | `conversation-relocated` |
| D — Composer + menu | `SessionActionMenu`, `SessionChat` | Move vs empty peer |
| E — Agent tool | `cli` RPC + tool registration | `hapi_suggest_peer_session` |
| F — Docs | upstream guide when ready | Terminology + agent prompt |

---

## 11. Upstream issue draft (copy-paste)

**Title:** Product: Peer sessions — move conversation + agent suggestions

**Body:**

### Problem

Operators mid-session realize the chat should have been a **dedicated session**. Today: manual spawn, copy-paste, or cluttered parent. Subagents are in-session only; ghosts are unintentional rows.

### Proposal

- **Move conversation to peer** — relocate message range to new session; parent keeps tombstone + link.
- **Fresh peer** — linked empty child (parallel work).
- **API:** `POST /api/sessions/:parentId/spawn-peer` with `mode`, `relocate`, metadata.
- **Agent:** `hapi_suggest_peer_session` + confirmation card (no auto-fork).

### Acceptance

Fork plan `docs/plans/2026-05-30-peer-agent-offering.md` §8.

### Related

#728 ghosts · #446 sidebar grouping

---

## 12. Open questions (for operator)

1. **Default navigate** — open child after relocate? (spec recommends yes)
2. **CLI sync depth** — v1 hub-only relocate OK, or block ship until parent agent gets explicit "context moved" message via queue?
3. **Suggestion tool** — upstream in one PR with relocate, or relocate first / suggestions second?
4. **Voice** — "move this conversation" → relocate API with outline-default slice?

---

## 13. Dogfood test #1 (manual relocate)

**Doc:** [`peer-relocate-dogfood-1.md`](peer-relocate-dogfood-1.md)  
**Script:** `scripts/peer-relocate-dogfood.sh`

First live relocate: mermaid thread (seq 231–264) out of peer-agent parent session `8d4f8729-…` into peer `cf9e7674-…`. Hub DB move + tombstone user message + parent `/summarize` with pre-diversion recap + child bootstrap. **Not** IDE transcript expunge; **not** metadata API yet.

---

## Changelog

| Date | Change |
|------|--------|
| 2026-05-30 | Initial spec from imported peer-agent backlog thread |
| 2026-05-30 | First-class **relocate** + parent tombstone; agent suggestion contract |
| 2026-05-30 | Context truth: relocate requires parent `/compact` + child digest; `parentCompactTargetPct` policy |
| 2026-05-30 | Compact prompt includes pre-diversion recap; 40% default locked; Cursor §4.4.1 capability vs wiring |
| 2026-05-30 | Dogfood #1 documented — manual script, 34 msgs relocated |
