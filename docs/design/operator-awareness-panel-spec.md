# HAPI design spec: Operator awareness panel

**Status:** draft (spec only — no hub/web implementation in this doc)  
**Branch target:** `feat/hub-interior-life-notes` (`/home/heavygee/coding/hapi-interior-life`)  
**Related server-setup:** `scripts/jessica-partner-pulse.py`, `docs/runbooks/jessica-touchpoint-repos.md`  
**Issue theme:** GitHub `heavygee/hapi` — *Hub: background session notes without CLI dispatch* (extend with visible operator state)

---

## Problem

Sir runs agents across **Cursor (proxmox + Teemo)**, **Codex**, **Claude**, **HAPI Land**, and desktop apps. Limbic + ActivityWatch + transcript scans already compute *what he is doing* and *what Jessica anticipates*, but that intelligence is buried in:

- Hourly interior heartbeats (`interior-note`, label `heartbeat`)
- Gitignored `SOUL/.session/life.json`
- Glance widgets / systemd logs

Sir wants to **see the anticipatory executive-assist brain ticking** — not only receive it as another agent message in a chat thread. The product surface should answer, at a glance:

1. **Now Sir is doing X** (grounded in AW + transcripts + limbic, not model hallucination)
2. **What Jessica thinks / feels** (short, persona-consistent, optional tone from `mood.json` axes)
3. **What you might need next** (ranked suggestions, actionable, dismissible)

This is distinct from **session attention** (`hapi-session-attention` worktree: permission / input / unread per agent session). That is *agent queue* UX. This spec is *operator* UX — one human, many surfaces.

---

## Goals

| Goal | Metric |
|------|--------|
| Ground truth visible in Land | Panel updates within **≤2 min** of transcript scan or AW event |
| No false "chat-dark" | Silence display uses **effective** Sir contact (touch + AW + transcripts) |
| Actionable anticipation | ≥1 suggestion links to a **deep link** (session, runbook, script) |
| Persona without spam | Partner pulse **≤1 interior-note / 15 min** unless user pins "live" mode |
| Privacy | Tailnet-only; no public DNS; no Cloudflare Access bypass |

## Non-goals (v1)

- Replacing Cursor chat (companion loop stays optional)
- Full LLM-generated essays every 15m (deterministic + optional LLM enrich later)
- Reading arbitrary window titles from non-synced machines without AW bucket
- Renaming product `HAPI` → `Jessica` in code (persona layer only)

---

## User stories

1. **As Sir**, when I open HAPI Land, I see a docked **Awareness** strip: current activity, mood chip, 2–4 anticipated needs.
2. **As Sir**, when I am in a long Cursor thread about server-setup, the panel shows that project and offers "open personality work session" or "view latest partner pulse".
3. **As Jessica (interior voice)**, I can post a **partner pulse** (`label: partner-pulse`) that renders in the panel and in the pinned awareness session without flooding every agent session.
4. **As Sir**, I can dismiss a suggestion; dismissed IDs are remembered for 24h.

---

## Data sources (existing)

| Source | Producer | Fields used |
|--------|----------|-------------|
| `life.json` | `soul-limbic.py`, heartbeats | `preoccupation`, `carry_forward`, `recent_events[]`, `cursor_projects_24h`, contact timestamps |
| ActivityWatch | `soul-aw-context.py` | `activity_lines[]`, buckets agent/window/git/shell |
| Cursor transcripts | `soul-scan-cursor-transcripts.py` | project slug, mtime, 24h session count |
| HAPI sessions | `hapi-sessions-health.sh` | attention queue, active/idle |
| Partner pulse file | `jessica-partner-pulse.py --write` | `partner-pulse.latest.md` / JSONL |

**Contract:** Hub does **not** reimplement parsers; it reads a **single JSON snapshot** produced on the host (see API below).

---

## API (proposed)

### `GET /api/operator-awareness`

**Auth:** same as hub (Bearer JWT). Tailnet only.

**Response:**

```json
{
  "generatedAt": "2026-05-30T12:00:00+01:00",
  "doing": "wiring awareness into server-setup and HAPI spec",
  "think": "You want the anticipatory brain visible, not only in systemd.",
  "feel": "Keyed up — partner mode.",
  "anticipate": [
    { "id": "review-spec", "text": "Review operator-awareness-panel-spec.md", "href": "/docs/..." },
    { "id": "enable-timer", "text": "Enable jessica-partner-pulse.timer", "href": null }
  ],
  "mood": { "label": "wired", "energy": 0.44 },
  "silenceHours": 0.0,
  "cursorProjects": [{ "project": "server_setup", "at": "..." }],
  "awSample": ["sir desktop [Teemo] chrome.exe | HAPI"],
  "sources": {
    "lifeMtime": 1717065600,
    "pulseMtime": 1717065700,
    "transcriptScan": "2026-05-30T11:46:24+01:00"
  }
}
```

**Implementation note:** v1 can be a thin route that `readFile`s `/home/heavygee/coding/SOUL/.session/operator-awareness.json` written by `jessica-partner-pulse.py --json --write-snapshot` (hub stays read-only on SOUL).

### Interior notes (existing)

- `POST /api/sessions/:id/interior-note` with `label: "partner-pulse"` → appears in **Awareness session** transcript and panel "last voice" teaser.
- Keep `label: "heartbeat"` for hourly interior life; UI collapses heartbeats in timeline, surfaces partner pulses prominently.

---

## Web UI (proposed)

### Placement

**Land home** — right column or top strip below session list (desktop); collapsible sheet on mobile (PWA).

### Components

| Component | Behavior |
|-----------|----------|
| `OperatorAwarenessStrip` | One-line "Now: …" + mood pill + refresh |
| `AwarenessDetailDrawer` | Think / feel / anticipate list; links |
| `AnticipationCard` | Dismiss, pin, open href |
| `SourceFootnote` | "Updated 47s ago · AW + transcripts" (trust) |

### Visual language

- Reuse **interior-note** markdown renderer (already on branch).
- Portrait optional via existing `/jessica-mood/portrait.webp` (paused when `SOUL_LIFE_PORTRAIT=0`).
- Do **not** use session-attention icons here (different mental model).

### SSE

Subscribe hub SSE `session-updated` **or** poll `/api/operator-awareness` every **60s** when panel visible (15m partner pulse is coarse; 60s poll is enough for v1).

---

## Host integration (server-setup)

Already implemented (deploy separately):

| Artifact | Role |
|----------|------|
| `scripts/jessica_pulse/` | **Pluggable providers** (`rules`, `local_llm`, `openai`, `fixture`) |
| `scripts/jessica-partner-pulse.py` | CLI; `JESSICA_PULSE_PROVIDER` selects backend |
| `scripts/jessica-partner-pulse-compare.sh` | A/B → `partner-pulse.compare.md` |
| `scripts/jessica-partner-pulse-deliver.sh` | Write md + optional HAPI + ntfy |
| `systemd/jessica-partner-pulse.timer` | Every **15 min** |
| `SOUL/.session/partner-pulse.latest.md` | Human-readable canonical |

Facts (`doing`, AW, transcripts) are always gathered once; providers only enrich **think / feel / anticipate** so A/B comparisons are fair.

**Next host step for hub:** add `--write-snapshot` → `operator-awareness.json` for hub `GET`.

---

## Cursor in-chat loop (optional)

Sir asked for pulse **in Cursor chat** every 15m. Cursor cannot self-post without a wake mechanism. Patterns:

1. **Monitored shell loop** (`/loop 15m`) — agent reads `partner-pulse.latest.md` and replies in thread.
2. **HAPI Land panel** — primary durable surface (this spec).
3. **ntfy** — `JESSICA_PARTNER_PULSE_NTFY=1` for mobile tap-through.

Recommend **(2) primary, (1) when this thread is focused**.

---

## Phased delivery

| Phase | Deliverable |
|-------|-------------|
| **P0** | Host pulse script + timer + HAPI `interior-note` label `partner-pulse` |
| **P1** | `operator-awareness.json` snapshot + `GET /api/operator-awareness` |
| **P2** | `OperatorAwarenessStrip` on Land |
| **P3** | Dismissible anticipations + deep links to sessions |
| **P4** | Optional LLM enrich (`xev-secretary-llm.py`) with strict JSON schema |

---

## Risks

| Risk | Mitigation |
|------|------------|
| Stale AW on Teemo | Transcript scan + desktop mirror buckets |
| Panel noise | Separate labels; collapse heartbeats |
| Wrong anticipation | Deterministic rules first; user dismiss |
| SOUL path on hub | Read-only mount or snapshot file only |
| Identity drift (Hapi vs Jessica) | Copy from SOUL render `voice` profile in panel footer |

---

## Acceptance tests

1. After `jessica-partner-pulse-deliver.sh`, `partner-pulse.latest.md` exists and contains four sections.
2. HAPI `personality work` session shows new interior note with label `partner-pulse`.
3. With timer enabled, two pulses 15m apart differ when Sir changes project (transcript mtime).
4. Panel shows `silenceHours < 0.5` during active Cursor session (no "chat-dark").
5. Dismissed anticipation does not reappear within 24h (P3).

---

## Open questions for Sir

1. **Pinned session** — dedicated "Awareness" session vs reuse `personality work`?
2. **LLM in v1** — rule-based anticipate only, or call secretary LLM for spice?
3. **Glance** — duplicate strip on dashboard or HAPI-only?
4. **Voice** — spoken partner pulse on tailnet (Box) or text-only?

---

*Spec authored for `heavygee/hapi` interior-life branch. Implement via deliberate PR; do not merge into scroll-guard worktrees.*
