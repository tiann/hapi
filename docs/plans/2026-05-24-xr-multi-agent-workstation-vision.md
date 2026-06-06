# XR multi-agent workstation (vision note)

Operator fork vision — **not** upstream canon. Captured 2026-05-24 after voice readback dogfood.

## Thesis: not monitor replacement — attention management

VR "productivity" has been stuck chasing **virtual monitors**: high-res text, many pixels, 4K per eye — because the job was *reading and typing code in VR*. That fight is largely unwinnable for dense text. **This project is not that job.**

| Monitor-replacement VR | HAPI XR |
|----------------------|---------|
| Primary channel: read lots of text | Primary channel: **listen + glance** |
| Fidelity: 4K+, font rendering wars | Fidelity: **identity + state + small snippets** |
| Limit: how many screens fit in FOV | Limit: **how many attention sources in 360°** |
| Embodiment: flat rectangles | Embodiment: **anything** (cube, plant, orb, avatar) |

**Operator thesis:** you get enough from **scanning small text** while **listening** to the focused agent. Large code review stays on real monitors (or one pinned surface). XR is the **switchboard layer**, not the IDE layer.

## Surfaces, not services

HAPI decomposes to a sphere of **surfaces** (not full web apps):

- **Emit** — state, alerts, short text, voice (TTS / readback)
- **Receive** — voice (mic), commands, approvals
- **Identify** — who this is (project, flavor, session summary) so operator context persists
- **Position** — place in space (or logical position on a 360° sphere)
- **Attract** — visual (pulse, flash, color) + **directional audio** (optional ping from behind)

A surface does not need a 4K terminal texture. It needs to be **findable, focusable, and legible at a glance**.

Embodiment is arbitrary: cube for jellybot, fern for docs agent, sphere for infra — **cosmetic**, not architectural. Architecture is `sessionId` + presence state + I/O channels.

## Core idea

A VR/XR workstation where many coding agents run in parallel, each embodied as a **spatial station** (anything — not necessarily a screen). The human selects **who they are talking to** the same way they select who they are looking at in a room: **gaze / eye focus**, not a session dropdown.

## Why VR specifically — modality shift

Flat UI collapses N agents into tabs. Physical monitors cap out at 3–8 rectangles in FOV before madness.

In XR + spatial audio:

- **360° × 360°** — agents can sit anywhere; turn around to address the one pinging you
- **Peripheral + behind-you** — pending agent flashes or whispers directionally; you **orient**, not alt-tab
- **Quantity is a different problem** — not "how many 4K panels" but "how many distinct attention channels can I track" (still finite — Miller's law applies — but higher than monitor wall)

**Attention and identification**, not text wall.

## Interaction model (draft)

| Signal | Meaning | System response |
|--------|---------|-----------------|
| Gaze dwell on agent X (> ~300ms) | Focus X | Route mic + voice TTS to session X; show X's chat/terminal large |
| Focused + user silent (> T seconds) | "I'm watching you work" | Optional status whisper: progress, last tool, ETA — **only if meaningful** |
| Agent X pending (permission, question, done) | Needs human | X's station **visual alert**; no global voice interrupt unless configured |
| Gaze moves to flashing X | Attention handoff | Auto readout: what X needs + suggested actions (voice + minimal UI) |
| Gaze elsewhere | Not focused | X stays visually pending; no speech spam |
| Turn body toward ping | Orient to off-screen agent | Directional audio + peripheral flash → focus on dwell |

## Minimal surface payload (what each agent shows)

When **not** focused:

- Identity glyph + label (project name, flavor icon)
- State color (working / pending / done / offline)
- Optional one-line status (≤ ~80 chars)
- Alert animation if pending

When **focused** (optional floating panel — small, not cinema):

- Last assistant snippet (markdown ok, **small**)
- Approve/deny if permission pending
- "Say more" expands to deeper view on real monitor or pinned 2D window

Voice carries the narrative; text is **captions + confirmation**, not the primary bandwidth.

## Mapping to HAPI today

| HAPI today | XR target |
|------------|-----------|
| Session = hub row + web route | Session = **world object** with stable `sessionId` |
| Single ElevenLabs ConvAI "Hapi" bridge | **Per-focus routing** — one voice pipeline bound to focused session (or one ConvAI with strict focus context — TBD) |
| SSE: thinking, ready, permission | **Presence states**: working / pending / offline → materials, glow, flash |
| `voiceHooks.onReady` readback | **Proactive speech on focus** when pending or on dwell-timeout |
| Web PWA | XR client (Quest, PCVR, Apple Vision — TBD) consuming same hub API + Socket.IO |

## Open design fights

1. **One voice persona vs N** — Single "foreman" vs each agent has voice. Foreman is cheaper; N agents is weirder and clearer.
2. **Interrupt policy** — Flash-only vs audio poke when non-focused agent blocks. Gardening model says: flash first, speak on focus.
3. **Eye vs head gaze** — Head is coarse (good enough for stations); eyes need calibration but enable "glance at pending" without turning neck.
4. **ConvAI cost** — N parallel voice sessions is bankruptcy. Focus-bound **one active voice channel** is the pragmatic default.
5. **2D falsification** — Build gaze+focus on desktop (click station = focus) before VR to prove routing without headset friction.

## Suggested build order (fork)

1. **Focus contract in hub** — `focusedSessionId` + broadcast; web/XR clients subscribe.
2. **Pending state surface** — derive from `agentState.requests`, `thinking`, ready events → `pendingReason`.
3. **Voice routing by focus** — replace implicit "current web route" with explicit focus (already partially `onSessionFocus`).
4. **Dwell + silence timers** — focus dwell → status update; pending + focus → auto readback (extends PR A/B voice work).
5. **XR shell** — minimal 3 stations, head/gaze raycast → focus API; flash shader on pending.

## Related fork docs

- [Mindmap agent layout (idea)](./2026-05-25-garden-mindmap-agent-layout-idea.md) — spatial groupings / relationships between orbs, not just an arc
- [Garden VR testing strategy](./garden-vr-testing-strategy.md) — max automated testing pyramid (CI tiers 0–4 + Quest smoke)
- `docs/plans/2026-05-23-voice-agent-state-integration.md` — mode state, interrupts, AGENT_NOTIFY
- Upstream #681 / #682 — ready readback (prerequisite for "tell me when I look at you")

## Friction / kill criteria

- If **desktop multi-panel + focus click** delivers 80% value, VR is optional polish not blocker.
- If maintainers never merge focus API, XR stays a fork client forever — acceptable for operator use.
- Kill VR track if eye tracking latency makes focus feel laggy (>200ms perceived).
