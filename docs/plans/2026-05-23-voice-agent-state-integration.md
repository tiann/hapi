# Plan: HAPI + Voice Agent State Layer (coexistence with upstream)

**Status:** Re-reviewed 2026-05-23 after proxmox dogfood start  
**Repo:** `/home/heavygee/coding/hapi` (cloned from `https://github.com/tiann/hapi`, upstream `main` @ `04d3d02`)  
**Author context:** Architecture conversation May 2026 - pivot from CursorRemote/CursorVox stack to HAPI as primary remote + multi-agent platform  
**Goal:** **Coexist with upstream HAPI** - extend, do not replace. Ship additive modules and a **voice-first modality** (local OpenAI-compatible speech stack) while keeping the tree **PR-able** against `tiann/hapi` at all times.  
**License note:** Upstream HAPI is **AGPL-3**. Any modified hub exposed on a network must comply with AGPL source-offer requirements (see [why-hapi.md](../guide/why-hapi.md) and root `LICENSE`).

---

## 1. Executive summary

We spent significant effort on **CursorRemote** (CDP → IDE composer remote control) and **CursorVox** (voice cockpit + deterministic routing → CursorRemote). The strategic direction has shifted:

| Old assumption | New assumption |
|----------------|----------------|
| Primary agent surface = Cursor IDE composer | Primary agent surface = **CLI agents** (`agent`, `claude`, `gemini`, etc.) |
| Remote = scrape Electron DOM (CursorRemote) | Remote = **wrap CLI sessions** with web/PWA/Telegram |
| Voice = custom FastAPI stack (CursorVox) | Voice = **orchestration layer** on top of remote hub (HAPI today uses ElevenLabs ConvAI) |

**HAPI** already delivers most of what we built toward: multi-agent remote control, session resume, permissions from phone, PWA, Telegram mini-app, optional Tailscale self-host, voice via ElevenLabs.

**This plan** is to **extend upstream HAPI in place** with the **differentiated layer we already designed in CursorVox**:

- Deterministic **voice agent mode state machine** (warm/cold idle, confirm gating, async execution phases)
- **`AGENT_NOTIFY_SUMMARY` contract** for machine-readable completion/status (shared with `agent-notify`)
- A **voice-first modality** backed by **local OpenAI-compatible endpoints** (STT/TTS/optional classifier LLM) - additive to today's ElevenLabs path, not a replacement fork
- **Modality wrapper** on outbound agent messages (voice-originated turns only)

**Coexistence contract:** Existing HAPI behavior (text UI, Telegram, ElevenLabs ConvAI, default settings) must keep working unchanged when new code is off or env vars unset. Every slice should be merge-shaped: isolated modules, tests, feature flags or config gates, minimal edits to existing call sites.

**Operator model (full spec):** §14 - *gardening while agents work* - async delegation, hub-owned truth, voice as thin classifier + speaker, responsive only when agents need you.

CursorRemote and CursorVox become **legacy / reference implementations**, not the primary product path.

### 2026-05-23 re-review decisions

After deploying HAPI on proxmox and starting a real Cursor session against `~/coding/jellybot`, the direction is still right, but the first implementation slice should be narrower:

- **Keep HAPI as primary**. CLR is a good Cursor-only reference, not a parallel production stack.
- **Prove state contract on existing ElevenLabs path first**, then add the **voice-first local modality** as a pluggable provider - not a parallel stack or sidecar.
- **Do not Docker the runner yet**. Hub-only Docker is possible later, but the runner needs host agent CLIs, auth, and workspace writes. Current boot path is systemd.
- **Treat Cursor remote mode separately**. HAPI Cursor remote mode uses `agent -p --output-format stream-json --trust`; it does not provide the same per-tool approval story as Claude/Codex.
- **Hook inbound assistant messages in CLI session handling**, not only `MessageService`. `hub/src/socket/handlers/cli/sessionHandlers.ts` is where CLI-originated messages are persisted and SSE updates are emitted.
- **Prefer session metadata/state over a new API endpoint at first**. Store derived voice mode / notify status in existing session update flow; add `GET /voice-mode` only if the web UI really needs it.

### CursorVox postmortem: do not port the intermediary agent blindly

The latest CursorVox run against `Workspaces / Project assessment and role clarification` showed the failure pattern clearly:

1. User asked, in fragments: "What is this project about?" then "its purpose" / "overall purpose".
2. CursorVox knew the bound target, but the dispatcher still kept asking which project/what context instead of using the selected session.
3. When it finally chose to dispatch, it spoke "I'm starting the workspace check now..." before the handoff was proven.
4. CursorRemote then failed delivery after three CDP attempts: text inserted + Enter pressed, but "Sent message was not observed in chat transcript after submit".
5. The user heard both a false start and an internal transport failure.

Conclusion: the **stateful voice intermediary agent** is the wrong thing to transplant. It adds a second conversation brain with stale memory, fuzzy target reasoning, and premature acknowledgements. HAPI should instead use:

- a thin voice tool layer that sends user intent to the already-selected HAPI session;
- deterministic state transitions derived from real HAPI events (`message queued`, `message consumed`, `agent ready/done`, `permission requested`);
- no "execution started" spoken acknowledgement until the hub has accepted/queued the message;
- `AGENT_NOTIFY_SUMMARY` as the completion/status contract, not dispatcher memory as truth;
- LLM voice routing only for lightweight intent classification/wording, never as the owner of task state.

---

## 2. Problem statement

### What HAPI solves today

- Run Claude Code, Codex, Cursor Agent CLI, Gemini, OpenCode locally
- Control from browser/PWA/Telegram while AFK
- Session handoff local ↔ remote, permission approval, terminal access
- Voice: ElevenLabs ConvAI → `messageCodingAgent` / `processPermissionRequest` client tools

Note: permission behavior is agent-flavor specific. Cursor remote mode currently runs with `--trust`, so voice-triggered Cursor tasks need extra guardrails if we want confirmation before destructive work.

See upstream: `README.md`, `docs/guide/how-it-works.md`, `docs/guide/voice-assistant.md`, `docs/guide/cursor.md`.

### What HAPI does not solve (our gap)

- **Voice completion readback** - handoff via `messageCodingAgent` works; summarizing coding-agent output after `thinking` stops is broken on production upstream (see §16)
- **Deterministic voice routing** - HAPI voice delegates intent to ElevenLabs LLM + two tools; CursorVox used dispatcher + explicit mode transitions
- **Optional `AGENT_NOTIFY_SUMMARY` parsing** - not in upstream; useful only for operators who add that tail convention to their own agent rules (see §6.2, §16)
- **Local speech stack** - HAPI is ElevenLabs-centric today; operator runs Speaches/Chatterbox on proxmox (`local-speech-agent` compose) as future `VOICE_BACKEND=local-openai` after upstream PR #401 lands
- **agent-notify integration** - stop-hook TTS/tmux driven by same contract as voice readback (operator-specific)
- **ElevenLabs conversation logging** - transcripts live on ElevenLabs unless hub archives them (WIP PR B, §16)
- **In-app builder surface** (future) - separate concern; shared `BuilderClient` interface may sit above HAPI REST/SSE later

### What HAPI voice actually is (ElevenLabs path today)

HAPI voice is **not** dumb STT + TTS. It is **ElevenLabs Conversational AI (ConvAI)**:

```text
Browser WebRTC ↔ ElevenLabs ConvAI (STT + orchestrator LLM + TTS)
                      ↓ client tools
              messageCodingAgent / processPermissionRequest
                      ↓
              HAPI hub session queue → coding agent CLI
                      ↑ contextual updates (voiceHooks)
```

- **Orchestrator LLM** (in auto-created agent): `gemini-2.5-flash` per `shared/src/voice.ts` / `buildVoiceAgentConfig()`
- **System prompt + tools:** `VOICE_SYSTEM_PROMPT`, same two client tools as our thin-adapter model
- **Hub role:** mint conversation token, accept queued messages, push session events to ConvAI via web hooks
- **ConvAI conversation logs:** `GET /v1/convai/conversations/{id}` on ElevenLabs (not on hub unless PR B lands)

This is the same architectural slot CursorVox tried to fill with a stateful Python dispatcher - HAPI already has the ConvAI intermediary; what's missing is **deterministic completion readback** and optional operator notify parsing.

### What CursorRemote solved (now secondary)

- IDE composer DOM control via CDP (`--remote-debugging-port=9222`)
- Only relevant when **Cursor IDE is open** with agent panel visible
- Path: `~/coding/CursorRemote/` - see `docs/architecture.md`, `docs/prd.md`

---

## 3. Strategic decision record

### Why not keep building CursorVox?

CursorVox proved voice → agent routing against **CursorRemote only**. That is the wrong substrate if the operator lives in **CLI agent mode** (Composer 2.5 Fast, no IDE chrome). HAPI + [cursor-local-remote](https://github.com/Vovch/cursor-local-remote) class tools address CLI remote; HAPI additionally unifies **Claude/Gemini/Codex**.

### Coexistence with upstream HAPI (primary strategy)

**We are not building a permanent fork or a second product.** We extend `tiann/hapi` so our work can land as **upstream PRs** (or a small series of PRs) once dogfood passes.

| Principle | Meaning |
|-----------|---------|
| **Additive modules** | New code lives in `shared/src/*`, `hub/src/voice/*`, optional `web/src/realtime/providers/*` - not scattered rewrites |
| **Default path unchanged** | ElevenLabs + existing web voice session remain the default; local voice-first is opt-in via settings/env |
| **Thin integration seams** | Hook `sessionHandlers.ts`, extend session metadata, wrap outbound sends - avoid replacing `syncEngine`, `messageService`, or auth |
| **PR-sized commits** | Each phase should be reviewable independently: parser + tests, mode engine + tests, modality wrapper, provider interface, local provider impl |
| **Track upstream** | Rebase or merge `tiann/hapi` regularly; resolve conflicts at integration seams, not by duplicating upstream files |
| **No sidecar in production** | CursorVox FastAPI → HAPI API doubles ops and session truth; reference only |

**Rejected for production:** permanent private fork without upstream path, sidecar voice stack, or changes that break ElevenLabs/text/Telegram when local voice is disabled.

**Optional extract later:** if upstream wants a smaller first PR, `@hapi/voice-state` or similar package boundary is fine - but integration stays in this repo until accepted upstream.

### Voice-first modality (local OpenAI-compatible)

A **modality** is a transport + orchestration path for the same HAPI session store - not a separate agent platform.

| Modality today | Modality we add |
|----------------|-----------------|
| Text (web/PWA, Telegram) | **Voice-first local** - mic/speaker loop on device or via hub proxy |
| ElevenLabs ConvAI (cloud STT/LLM/TTS, WebRTC) | **Local OpenAI-compatible stack** on tailnet (already operated on proxmox) |

**Local stack (existing ops, new HAPI adapter):**

| Role | Service | API shape |
|------|---------|-----------|
| STT | Speaches (`local-speech-agent`) | OpenAI-compatible `/v1/audio/transcriptions` |
| TTS | Chatterbox gateway | OpenAI-compatible `/v1/audio/speech` (HTTP; not WS realtime required for v1) |
| Classifier LLM (optional) | Local OpenAI-compatible chat (Speaches-hosted or separate) | `/v1/chat/completions` with same tool schema as `VOICE_TOOLS` |

**Shared across modalities (not duplicated per provider):**

- `VOICE_SYSTEM_PROMPT`, `VOICE_TOOLS`, `realtimeClientTools` → hub message path
- `voiceMode` state + `AGENT_NOTIFY` parsing in hub
- `modalityWrapper` on voice-originated sends
- `voiceHooks` context feed (session history, permissions, ready)

**Provider interface (PR-able shape):**

```text
VoiceTransportProvider (interface)
  ├─ ElevenLabsConvAIProvider   # existing; wrap current RealtimeVoiceSession path
  └─ LocalOpenAIVoiceProvider   # new; Speaches STT + local LLM tools + Chatterbox TTS
```

Selection via hub/web config (e.g. `voice.provider: elevenlabs | local_openai`) with env-backed base URLs for local endpoints. **No hard dependency** on local services in default build; CI runs without them.

**Voice-first UX (later slice):** optional UI entry that opens mic-first session (large talk control, minimal chrome) - still the same HAPI session underneath; can ship after provider abstraction lands.

### Decommission candidates (after HAPI slice passes)

| Service | Tailnet name | Action |
|---------|--------------|--------|
| CursorVox Docker `:7861` | `svc:cursorvox` | Deprecate after voice-state on HAPI |
| CursorRemote Docker `:3000` | `svc:cursor-d` | Keep optional for IDE-only workflows |
| Cursor CDP on teemo-ssd `:9222` | `svc:cursor-cdp` | Only needed if CursorRemote kept |

Scripts: `~/coding/server-setup/scripts/tailscale/harden-*-cursor*.sh`

---

## 4. Target architecture

```text
┌─────────────────────────────────────────────────────────────────┐
│  Phone / PWA / Telegram                                         │
│    ├─ Text UI (existing, unchanged default)                     │
│    ├─ Voice: ElevenLabs ConvAI (existing default)               │
│    └─ Voice-first: LocalOpenAIVoiceProvider (NEW, opt-in)     │
└────────────────────────────┬────────────────────────────────────┘
                             │ REST / SSE / Socket.IO
┌────────────────────────────▼────────────────────────────────────┐
│  HAPI Hub (upstream + additive extensions)                      │
│    ├─ syncEngine / messageService (existing, untouched core)    │
│    ├─ VoiceModeEngine (NEW) - per-session state machine         │
│    ├─ AgentNotifyParser (NEW) - AGENT_NOTIFY_SUMMARY on msgs    │
│    ├─ ModalityWrapper (NEW) - voice-originated outbound text    │
│    ├─ VoiceTransportProvider registry (NEW) - pluggable voice   │
│    └─ SQLite session metadata extensions (backward compatible)  │
└────────────────────────────┬────────────────────────────────────┘
                             │ Socket.IO
┌────────────────────────────▼────────────────────────────────────┐
│  HAPI CLI → claude | agent | gemini | codex | opencode          │
└─────────────────────────────────────────────────────────────────┘

Optional future: agent-notify stop hook reads same JSONL contract
```

---

## 5. HAPI integration map (start here in this repo)

Read **`docs/operator/AGENTS.md`** (canonical on this fork; upstream baseline inlined there). Key seams for voice-state work:

| Concern | HAPI path | Notes |
|---------|-----------|-------|
| Voice orchestrator prompt + tools | `shared/src/voice.ts` | `VOICE_SYSTEM_PROMPT`, `VOICE_TOOLS`, `buildVoiceAgentConfig()` - shared by all providers |
| Voice transport (default) | `web/src/realtime/RealtimeVoiceSession.tsx` | ElevenLabs ConvAI WebRTC - **unchanged default** |
| Voice transport (voice-first local) | `shared/src/voiceProvider.ts`, `hub/src/voice/providers/localOpenAi.ts`, `web/src/realtime/providers/` | **NEW opt-in** - OpenAI-compatible STT/TTS/chat |
| ElevenLabs token API | `hub/src/web/routes/voice.ts` | `POST /voice/token` |
| Web voice client tools | `web/src/realtime/realtimeClientTools.ts` | `messageCodingAgent`, `processPermissionRequest` - shared hub bridge for all providers |
| Web voice session registry | `web/src/realtime/RealtimeSession.ts` | Provider-agnostic session id + hooks |
| Inbound assistant/agent messages | `hub/src/socket/handlers/cli/sessionHandlers.ts` | **Primary hook for AGENT_NOTIFY + mode transitions** after CLI message normalization and persistence |
| Outbound user messages | `hub/src/sync/messageService.ts` | Web/Telegram queued send path; useful for voice-origin metadata and wrappers |
| Session lifecycle | `hub/src/sync/syncEngine.ts`, `hub/src/sync/sessionCache.ts` | Activity, ready events |
| Persistence | `hub/src/store/sessions.ts`, `hub/src/store/messages.ts` | Extend metadata |
| Permissions (phone approve) | `hub/src/web/routes/permissions.ts` | Already agent-flavor aware |
| Notifications | `hub/src/notifications/` | May drive proactive voice readback |
| Cursor CLI wrapper | `docs/guide/cursor.md`, `cli/src/cursor/` | Remote mode: `agent -p --output-format stream-json --trust --resume`; no per-tool remote approval |

### Suggested new modules (names tentative)

```
shared/src/voiceMode.ts              # ModeState enum, transitions, types
shared/src/agentNotify.ts            # Parse/strip AGENT_NOTIFY_SUMMARY JSON
shared/src/voiceProvider.ts          # VoiceTransportProvider interface + types (PR boundary)
hub/src/voice/modeEngine.ts          # Pure transition helper invoked by sessionHandlers
hub/src/voice/modalityWrapper.ts     # Outbound prompt wrapping
hub/src/voice/providers/localOpenAi.ts # Speaches STT + OpenAI chat tools + Chatterbox TTS
web/src/realtime/providers/          # Client-side provider wiring; ElevenLabs stays default export
```

**PR discipline:** prefer new files + re-exports over editing upstream-heavy files. When editing existing files (`sessionHandlers.ts`, `realtimeClientTools.ts`, `voice.ts`), keep diffs minimal and behind config checks.

---

## 6. Legacy assets to mine (external repos)

All paths under `~/coding/` unless noted.

### 6.1 CursorVox - voice agent state + routing (PRIMARY)

**Repo:** `~/coding/cursorvox/`  
**Architecture doc:** `cursorvox/docs/ARCHITECTURE.md`  
**Operator guide:** `cursorvox/docs/OPERATOR_GUIDE.md`  
**Interface spec:** `cursorvox/docs/plans/2026-04-29-legit-cursorvox-interface-spec.md`

| File | Port? | What it does |
|------|-------|--------------|
| `src/cursorvox/voice_mode_state.py` | **Yes → TS** | Mode state machine: `idle_warm`, `idle_cold`, `align_intent`, `await_confirm`, `executing_async`, `reporting`, `blocked`; transitions from agent text + user turns |
| `src/cursorvox/modality.py` | **Yes → TS** | Wraps voice user messages; injects `[CursorVox mode context]` + `AGENT_NOTIFY_SUMMARY` output contract |
| `src/cursorvox/voice_speakable.py` | **Yes → TS** | Strip `AGENT_NOTIFY_SUMMARY` tail before TTS |
| `src/cursorvox/command_router.py` | Partial | Target resolution + focus + `send_message` - **replace** with HAPI session targeting; keep confirm/approve routing ideas |
| `src/cursorvox/safety.py` | Partial | High-risk command gating before mutate |
| `src/cursorvox/dispatch_agent.py` | Cautionary reference | Do **not** port as a stateful intermediary agent. Mine only narrow tests/prompts for lightweight classification wording if needed. |
| `src/cursorvox/audio_intent.py` | Reference | Legacy deterministic intents; mostly superseded by dispatcher |
| `src/cursorvox/targets.py` | **No** (IDE) | VoiceTarget from CursorRemote `windowSnapshots` - CLI sessions use HAPI session list instead |
| `src/cursorvox/cursorremote_client.py` | **No** | Socket.io bridge to CursorRemote - obsolete on CLI-first path |
| `src/cursorvox/app.py` | Reference | FastAPI routes, health, voice intent handler wiring |
| `src/cursorvox/proactive.py`, `attention*.py` | Later | Proactive spoken queue from agent state - port after core loop |
| `src/cursorvox/tts/chatterbox_gateway.py` | **Yes** | HTTP TTS to local gateway |
| `src/cursorvox/tts/speaches.py` | **Yes** | STT/TTS HTTP to Speaches |

**Tests to read before porting:**

- `cursorvox/tests/test_modality.py`
- `cursorvox/tests/test_voice_speakable.py`
- `cursorvox/tests/test_audio_intent_processor.py` (mode/confirm scenarios)
- `cursorvox/tests/test_targets.py` (skip if not doing IDE targeting)

**Local speech stack (operational):**

- CursorVox README documents Speaches `:18001`, Chatterbox gateway `:18008` via `local-speech-agent` compose
- `cursorvox/docker-compose.yml` - env patterns for `CURSORREMOTE_BASE_URL` (will become HAPI hub URL)

### 6.2 agent-notify / AGENT_NOTIFY_SUMMARY (optional operator convention)

**Repos:** `~/coding/agent-notify/` (spec), operator `~/coding/AGENTS.md` (optional rule)  
**Canonical spec:** `agent-notify/ACTUALSPEC.md`

**Upstream framing (critical):** `AGENT_NOTIFY_SUMMARY` is **not** a HAPI built-in requirement. Most HAPI users will never emit it. It is an **optional machine-readable tail** some operators add to **their own** agent instructions (`AGENTS.md`, project rules, hooks). HAPI should:

- Parse it **when present** in assistant messages
- Prefer `summary` for voice readback when parsed
- **Never** require agents to emit it
- **Never** add it to upstream HAPI default prompts

When present, the JSON tail is source of truth for spoken/read status (`action`, `status`, `summary`, etc.) for that operator's stack.

Planned HAPI behavior (PR C / Phase 1):

1. Parse from hub message stream (`shared/src/agentNotify.ts`)
2. Drive mode transitions when combined with mode engine (`done` → `idle_warm`, etc.)
3. Feed speakable text to voice output (strip JSON tail)
4. Optionally share parsed object with agent-notify stop hook (operator deploy only)

### 6.3 CursorRemote - IDE remote (LEGACY REFERENCE)

**Repo:** `~/coding/CursorRemote/` (this workspace)

| Asset | Relevance |
|-------|-----------|
| `docs/architecture.md`, `docs/prd.md` | CDP/DOM model - understand what we're **not** building on |
| `src/server/command-executor.ts` | Send message verification pattern |
| `src/server/activity-derive.ts` | Agent idle/heuristic detection (inferior to AGENT_NOTIFY) |
| `src/server/relay.ts` | socket.io command protocol - different from HAPI |
| Tailscale/Docker setup | **Reuse patterns** for HAPI: `Dockerfile`, `docker-compose.yml`, `DEVELOPMENT.md`, server-setup hardening scripts |

Do **not** wire new voice-state to CursorRemote unless explicitly maintaining IDE lane.

### 6.4 cursor-local-remote (alternative CLI remote)

**Upstream:** https://github.com/Vovch/cursor-local-remote (`clr`)

Lighter-weight Cursor-only CLI remote. HAPI supersedes for multi-agent; CLR useful as reference for:

- `agent -p --output-format stream-json` + session transcript paths under `~/.cursor/projects/`
- Cursor-first session browser UX
- Git panel from phone (diff, commit, push, branch)
- Simple webhook completion notifications (for `ntfy` / Discord / Slack style sinks)

Do not run CLR beside HAPI as a production stack unless explicitly testing a UX gap; two remotes spawning Cursor sessions will create duplicate control surfaces.

### 6.5 Infrastructure

| Path | Use |
|------|-----|
| `~/coding/server-setup/scripts/tailscale/harden-*-cursor*.sh` | Template for `harden-hapi-service.sh` |
| `~/coding/server-setup/docs/runbooks/tailscale-internal-services.md` | Runbook pattern |
| `~/coding/cursorvox/docs/plans/2026-04-29-legit-cursorvox-interface-spec.md` | UX requirements that may inform HAPI web voice UI |

---

## 7. Phased implementation plan

**Upstream alignment:** Phases map to merge-shaped PRs in **§16**. Prefer landing upstream PR **#401** (pluggable backends) before local OpenAI provider work.

### Phase 0 - Baseline dogfood (partly complete)

- [x] Run HAPI on proxmox with hub + runner + Tailscale Serve
- [x] Confirm no third-party relay: hub binds `127.0.0.1:3006`; Tailscale Serve publishes `https://hapi.tail9944ee.ts.net/`
- [x] Run one Cursor session from web/PWA against `~/coding/jellybot`
- [x] Remove `specstory run ...` shell alias interference so HAPI resolves real `agent`, `codex`, and `gemini` binaries
- [x] Read `shared/src/voice.ts` + `web/src/realtime/realtimeClientTools.ts` end-to-end
- [x] ElevenLabs voice dogfood: hello test + subtitle-search feature (see §16.3-16.4, `docs/dogfood/`)
- [x] Document upstream PR strategy and ConvAI architecture insight (§16)
- [x] Decide integration shape: **coexist with upstream**; additive modules; PR series to `tiann/hapi` (not permanent fork or sidecar)
- [ ] Verify real non-Cursor agent sessions from web: Claude, Codex, Gemini
- [ ] Document AGPL compliance for `svc:hapi` on tailnet
- [ ] Help rebase/review upstream **PR #401** (pluggable voice backends) - see §16.7

**Exit criteria:** Dogfood evidence written; go/no-go in §10; voice handoff proven (messageCodingAgent → hub 200).

### Phase 1 / PR C - Optional AGENT_NOTIFY parsing + mode state

- [ ] **PR A first (upstream):** fix ready-event inline assistant text (§16.6) - can ship before this phase
- [ ] **PR B (upstream):** ElevenLabs transcript archive (§16.6)
- [ ] Port `AGENT_NOTIFY_SUMMARY` parser → `shared/src/agentNotify.ts` (**opt-in convention only**)
- [ ] Port mode state types + transitions from `voice_mode_state.py` → `shared/src/voiceMode.ts`
- [ ] Hook `hub/src/socket/handlers/cli/sessionHandlers.ts`: on assistant message, parse notify JSON when present, update session voice mode
- [ ] `voiceHooks.onReady`: prefer parsed notify `summary` over last-message heuristic when available
- [ ] Add unit tests mirroring `cursorvox/tests/test_modality.py`, `test_voice_speakable.py`
- [ ] Publish state through existing session update/SSE path
- [ ] Keep stored chat messages intact; strip contract tail only at voice/TTS boundaries

**Exit criteria:** When operator agent emits notify line, voice readback uses `summary`; when absent, PR A last-message behavior still works.

### Phase 2 - Outbound modality wrapper (PR D)

- [ ] Port `wrap_voice_user_message()` behavior → `hub/src/voice/modalityWrapper.ts`
- [ ] Add explicit `sentFrom: 'voice'` (or equivalent metadata) from `realtimeClientTools.ts` through the hub send path
- [ ] Apply wrapper only when message origin = voice
- [ ] Confirm gating: `await_confirm` blocks `messageCodingAgent` until user confirms (port logic from `command_router.py`; avoid `dispatch_agent.py` as state owner)
- [ ] Ack policy: spoken "sent" only after hub persists/queues message (see §14.6)

**Exit criteria:** Voice-originated sends include mode context; agent replies with parseable `AGENT_NOTIFY_SUMMARY`; confirm flow works on destructive request; failed queue never produces execution narrative.

### Phase 3 - Pluggable backends (#401) + local OpenAI (PR E)

- [ ] Land or rebase upstream **[PR #401](https://github.com/tiann/hapi/pull/401)** (`VOICE_BACKEND=elevenlabs | gemini-live | qwen-realtime`, `GET /api/voice/backend`) - §16.7
- [ ] Stack PR A/B/C on `VoiceBackendSession` if #401 merges first
- [ ] Extend ElevenLabs/Gemini prompts with mode-aware instructions (backward compatible)
- [ ] Wire proactive readback on mode transition to `reporting` / notify `status: done`
- [ ] **PR E:** `VOICE_BACKEND=local-openai` - Speaches STT + OpenAI-compatible chat tools + Chatterbox TTS (after #401 interface exists; do not parallel-switcher)
- [ ] Optional: voice-first mic-primary UI entry

**Exit criteria:** Default ElevenLabs unchanged; Gemini Live or local-openai dogfood passes subtitle-search scenario with audible completion summary.

### Phase 4 - Ops + decommission

- [x] Tailscale serve `svc:hapi` on proxmox (mirror cursorvox/cursor-d pattern)
- [x] `hapi-runner.service` for remote spawn without terminal babysitter
- [ ] Consider hub-only Docker/Compose after core dogfood; keep runner on host unless a container auth/workspace model proves cleaner
- [ ] Archive CursorVox docker stack; document legacy CursorRemote IDE lane
- [ ] Update `~/coding/AGENTS.md` or homelab runbook with new canonical remote URL

---

## 8. Explicit non-goals (v1)

- Replacing HAPI's core sync/session architecture
- CDP / Cursor IDE DOM scraping in this integration
- Multi-user tenancy beyond HAPI namespaces
- In-app builder pull-down UI (separate future project; may call HAPI REST)
- Breaking or removing upstream ElevenLabs voice for users who do not opt into local modality
- A permanent private fork that diverges without a PR path to `tiann/hapi`
- Requiring local speech services in default install or CI

**Not a non-goal:** upstream PRs - dogfood first, then open PR-sized slices once tests and default-path regression pass.

---

## 9. Testing strategy

| Layer | Approach |
|-------|----------|
| `agentNotify` / `voiceMode` | Port existing CursorVox unit tests to Vitest |
| Hub message hooks | Extend `hub/src/socket/handlers/cli/sessionHandlers` tests/patterns; use `messageService` tests for outbound user-message metadata |
| Voice tools | Mock session + simulate `messageCodingAgent` RPC |
| Provider regression | With default config, ElevenLabs path matches upstream behavior (no local services required in CI) |
| Local provider | Optional integration tests behind env flag; mock OpenAI-compatible HTTP |
| E2E | Manual dogfood matrix from `cursorvox/scripts/dogfood_voice_self_loop.py` (adapt for HAPI) |

---

## 10. Open questions (for cold eval agent)

**Decided (May 2026 dogfood):**

| Question | Decision |
|----------|----------|
| Upstream workflow | Coexist with `tiann/hapi`; PR series §16; no permanent fork |
| Voice architecture | ElevenLabs ConvAI is already the thin intermediary; fix readback + logging, not rebuild dispatcher |
| AGENT_NOTIFY | **Opt-in** operator convention only; parse when present (PR C) |
| Pluggable backends | **Track PR #401**; local Speaches/Chatterbox = PR E after #401 |
| No upstream issue | File PR A with dogfood evidence; reference #640 and #401 |

**Still open:**

1. **AGPL:** Private tailnet only - is source offer to household devices sufficient via git mirror?
2. **CursorRemote:** Full decommission or keep `cursor-d` for IDE composer indefinitely?
3. **agent-notify:** Hub webhook vs continue relying on Cursor stop hook + JSONL scan (operator deploy)?
4. **Docker:** Hub-only Compose after core dogfood?
5. **Cursor permissions:** Is `--trust` acceptable for remote Cursor sessions, or separate voice guardrails?
6. **AGENT_NOTIFY upstream docs:** Generic JSON shape only vs link to external community spec?
7. **PR #401 default backend:** Confirm `DEFAULT_VOICE_BACKEND='elevenlabs'` on rebased head (early branch flipped to gemini-live; author claims revert)
8. **PR #401 Composer Enter change:** Split out of voice PR or get explicit tiann OK? (HAPI Bot blocker; author claims separate request)
9. **PR #640 ready trigger:** Confirm SSE-only path before stacking PR A

---

## 11. Local environment (ElevenLabs voice)

Secrets live in **gitignored** env files (not committed):

| File | Purpose |
|------|---------|
| `~/coding/hapi/.env` | Repo-level reference; same active key |
| `~/coding/hapi/hub/.env` | **Loaded by Bun** when running `cd hub && bun run dev` |
| `~/coding/hapi/.env.example` | Template without secrets |

**Active key:** `hg` (heavygee). Alternates `justg` and `gc` are commented in both `.env` files - swap by commenting/uncommenting `ELEVENLABS_API_KEY` (one active only).

For single-binary / CLI outside `hub/`, export before start:

```bash
set -a && source ~/coding/hapi/.env && set +a
```

Voice requires `ELEVENLABS_API_KEY` on the **hub process** (`hub/src/web/routes/voice.ts`).

**API key permissions:** Auto-create agent + conversation token require ElevenLabs scopes **`convai_read`** and **`convai_write`**. Keys with TTS-only scopes fail with HTTP 500 *"Failed to create ElevenLabs agent automatically"* or missing permission errors on list/create endpoints.

Optional after first auto-create: set `ELEVENLABS_AGENT_ID=agent_...` in `hub/.env` to skip create step.

### Tailscale (proxmox, no third-party relay)

**URL:** `https://hapi.tail9944ee.ts.net/`

| Item | Path |
|------|------|
| Harden (VIP + ACL + Serve) | `~/coding/server-setup/scripts/tailscale/harden-hapi-service.sh` |
| Boot units | `sudo ~/coding/server-setup/scripts/tailscale/install-hapi-tailnet-services.sh` |
| Verify | `~/coding/server-setup/scripts/verify-hapi-tailnet.sh` |
| Hub systemd | `server-setup/systemd/hapi-hub.service` |
| Runner systemd | `server-setup/systemd/hapi-runner.service` |
| Serve systemd | `server-setup/systemd/tailscale-serve-hapi.service` |

Do **not** run `hapi hub --relay`. Hub binds `127.0.0.1:3006`; Tailscale Serve proxies HTTPS only on your tailnet.

After first hub start: **`CLI_API_TOKEN`** in `~/.hapi/settings.json` — use for phone/web login.

Current proxmox runner workspace roots:

- `/home/heavygee/coding`
- `/home/heavygee/coding/hapi`

No official HAPI Docker image exists for this project. `hapiproject/hapi` on Docker Hub is unrelated HAPI FHIR. If Docker is added, start with hub-only Compose; keep the runner host-native until agent CLI auth and workspace mounts have a tested contract.

---

## 12. Quick start for next agent

```bash
cd ~/coding/hapi
bun install
bun typecheck
bun run test

# Terminal 1 - hub (loads hub/.env)
bun run dev:hub   # or use existing hapi-hub.service on proxmox

# Terminal 2 - CLI session
npx @twsxtd/hapi cursor   # or bun cli after build; verify agent on PATH

# Production-ish proxmox path
systemctl status hapi-hub.service hapi-runner.service tailscale-serve-hapi.service
hapi runner status

# Read this plan (§14 operator model, §16 upstream PR handoff + dogfood)
less docs/plans/2026-05-23-voice-agent-state-integration.md

# Reference repos
ls ~/coding/cursorvox/src/cursorvox/voice_mode_state.py
ls ~/coding/cursorvox/src/cursorvox/modality.py
ls ~/coding/agent-notify/ACTUALSPEC.md
ls ~/coding/CursorRemote/docs/architecture.md
```

---

## 13. Conversation context (how we got here)

Condensed arc for the eval agent:

1. Built **CursorRemote** to remote-control **Cursor IDE composer** via CDP (Tailscale `cursor-d`, Docker on proxmox).
2. Built **CursorVox** as voice cockpit → CursorRemote (`cursorvox` tailnet), local Speaches/Chatterbox, dispatcher-led intents, mode state machine, `AGENT_NOTIFY_SUMMARY`.
3. Identified **inside-out app builder** loop (in-app surface → agent → reload) as separate from voice remote.
4. Recognized **CLI agent** (Composer 2.5 Fast, no IDE) as primary modality - CursorRemote cannot see CLI sessions.
5. Found **HAPI** (and CLR) as existing CLI remote multi-agent solutions.
6. Concluded HAPI subsumes CursorRemote+CursorVox **platform role**; our value is the **voice agent state layer** to graft on.

---

## 14. Operator model: gardening while agents work (full spec)

This section is the **product and architecture contract** for voice on HAPI. It captures everything worth keeping from the CursorVox attempt, everything we refuse to repeat, and the operator stance:

> **I am doing the gardening. I want my agents kept busy. I want to be responsive when they actually need me - not nagged, not lied to, not asked which bed I'm standing in when I already picked one.**

That sentence is the north star. Implementation must optimize for **async delegation + selective interruption**, not for **conversational co-piloting**.

### 14.1 Roles (who owns what)

| Actor | Job | Must NOT do |
|-------|-----|-------------|
| **Operator (you)** | Pick session, delegate tasks, approve/deny, unblock, occasionally check status | Babysit tool traces, re-explain context the agent already has |
| **Coding agent (CLI)** | Execute work, emit `AGENT_NOTIFY_SUMMARY`, ask when blocked | Assume voice heard a message that never queued |
| **HAPI hub** | Session truth, message queue, permissions, mode state, SSE/events | Guess intent from stale sidecar memory |
| **Voice layer (ElevenLabs + web tools)** | STT/TTS, classify utterance → HAPI tool, speak hub-backed updates | Own task state, target resolution, or "worker started" fiction |
| **Modality wrapper (hub)** | Inject voice-only execution policy into **outbound** user messages | Pollute desktop/non-voice turns |

CursorVox collapsed the last three rows into a **dispatch orchestrator** (`dispatch_agent.py`) that tried to be a second agent. That is the spaghetti. HAPI splits them again.

### 14.2 Gardening metaphor → mode states

Port the **deterministic mode machine** from `voice_mode_state.py`, but store transitions in **HAPI session metadata**, driven by hub events - not dispatcher memory.

| Mode | Gardener experience | Voice should | Hub/driver events |
|------|---------------------|--------------|-------------------|
| `idle_warm` | Just finished a task; still in flow | Stay quiet unless spoken to; short acks OK | Agent `status: done` notify; recent report within warm window (~30 min) |
| `idle_cold` | Away for hours; context stale | On next task, **recap first** then confirm intent | Time since last report exceeds warm window; or long gap since user turn (~12 h cold recap) |
| `report_refresh` | "What's going on?" while hands busy | Answer from **session truth**: pending permissions, last notify summary, blocked | User check-in phrases ("what needs me", "where did we leave off"); read-only query |
| `align_intent` | New instruction, not yet sent | Mirror outcome briefly; clarify **task details only** | User message classified as work; before hub accepts queue |
| `await_confirm` | About to do something risky | Hold sends; ask yes/no/revise; **block** `messageCodingAgent` until resolved | High-risk intent or agent asked confirm; safety gate armed |
| `executing_async` | **Gardening** - agent should be busy | **Silence.** No "still working?" No filler. | Message queued + consumed; agent working; until notify or permission |
| `reporting` | Agent finished a beat worth hearing | Speak **notify summary** (stripped JSON tail), 1-3 sentences | Assistant message with parseable `AGENT_NOTIFY_SUMMARY` or ready + substantive reply |
| `blocked` | Agent needs you **now** | Clear blocker + concrete ask ("allow bash?", "pick A or B") | Notify `status: blocked`; permission pending; send failed; transport error |

**Warm vs cold idle** matters for returning gardeners: cold start should trigger recap + confirm, not "what project?" when the HAPI session is already selected.

### 14.3 What CursorVox proved worth keeping

These are **non-negotiable ports** (Phase 1-3):

1. **`AGENT_NOTIFY_SUMMARY` contract** (`modality.py`, `agent-notify/ACTUALSPEC.md`) - machine-readable completion; voice reads `summary`, mode reads `status`/`action`.
2. **Mode state machine** (`voice_mode_state.py`) - especially `executing_async` silence and `report_refresh` check-ins.
3. **Modality wrapper on voice sends only** (`wrap_voice_user_message`) - desktop CLI sessions stay normal; phone voice gets execution policy + mode context block.
4. **Speakable stripping** (`voice_speakable.py`) - never TTS the JSON tail or raw tool dumps.
5. **Confirm gating for risky work** (`safety.py`, `command_router.py` confirm paths) - two-step approve where needed; **hub-owned** pending confirm, not dispatcher memory.
6. **Read-only status intents** (Vox: `what_needs_me`, `read_last_response`) - answer from cache/state **without** spawning agent work.
7. **Attention semantics** (`ATTENTION_QUEUE_VOX.md`) - sort by "needs me now" (approval, blocked, action required) vs calm idle tabs.
8. **Auditability** (interface spec §8) - every voice turn should be traceable: heard → classified → hub action → spoken result.
9. **Operator guide flow** - arrive → check state → send work → approve in two steps when high risk.

### 14.4 What CursorVox proved we must NOT repeat

Documented in postmortem (2026-05-23 jellybot session) and reinforced by `voice-sessions.jsonl`:

| Failure | Evidence | HAPI rule |
|---------|----------|-----------|
| Second brain re-asks target | Bound session known; dispatcher still "which project?" | **Selected HAPI session is the target.** Voice never resolves windows/tabs. |
| Premature execution narrative | `"I'm starting the workspace check now..."` before transport proof | Speak **only after hub accepts/queues** message. Tool return `"sent"` is not enough if persistence fails - tighten in Phase 2. |
| Transport lies to user | CursorRemote: text inserted, Enter pressed, not in transcript | HAPI path: runner + CLI stream-json; failure surfaces as `blocked`, not fake progress |
| Dispatcher memory drift | `DispatchMemory.short_state/long_state` diverges from IDE | **No rolling dispatcher state.** Session messages + notify JSON are truth. |
| Over-clarification loops | User: "overall purpose" → still aligning | With bound session, clarify **task outcome only**, max N rounds then pass-through (configurable) |
| Chatty async | Filling silence while agent works | `executing_async` = **mandatory silence** in voice prompt + no proactive TTS except permissions/blockers/done |

`dispatch_agent.py` remains a **cautionary reference** - mine phrasing for lightweight classification if needed, never port as state owner.

### 14.5 Understanding intent (three layers, not one spaghetti LLM)

**Layer 0 - Transport interrupts (deterministic, optional port)**

Vox `intents.py` handles only hard interrupts: "stop talking", "be quiet". No semantic parsing. HAPI may add similar client-side hooks (mute TTS, end voice session) without LLM.

**Layer 1 - Voice LLM classifier (already in HAPI)**

`shared/src/voice.ts` + `realtimeClientTools.ts`:

- `messageCodingAgent(message)` - delegate work to **active session**
- `processPermissionRequest(allow|deny)` - respond to **hub's pending permission**
- Direct answer - meta/voice questions the assistant can answer from injected context

The LLM **classifies and phrases**. It does not maintain `pending_worker_message`, `short_state`, or choose targets.

Context for classification arrives via `voiceHooks.ts` → `sendContextualUpdate`:

- Session focus + history (`formatSessionFull`)
- New agent messages (`onMessages`)
- Permission requests (`onPermissionRequested`)
- Ready/done (`onReady`)

That is how the voice layer "understands" without owning task memory: **HAPI pushes truth in; LLM maps speech to tools.**

**Layer 2 - Hub mode gating (deterministic, Phase 2)**

Even if the LLM calls `messageCodingAgent`, the hub/client may **reject** when:

- `mode_state === await_confirm` and message is not confirm/revise/cancel
- High-risk mutation without completed confirm flow (port `safety.py` ideas)
- No active session / runner offline → spoken `blocked`, not dispatch

This is the Vox `command_router` lesson without the CursorRemote target picker.

**Explicit non-layer:** CursorVox `dispatch_agent.py` JSON (`action: ask_user | dispatch_worker`, rolling memory). **Deleted from architecture.**

### 14.6 Communicating with the agent on the user's behalf (end-to-end)

```text
User speech
  → STT (ElevenLabs today; Speaches later)
  → Voice LLM picks tool OR answers locally
  → [Gate] mode + safety check
  → realtimeClientTools.messageCodingAgent(msg)
  → sessionStore.sendMessage(sessionId, msg)   # must include sentFrom: voice (Phase 2)
  → hub messageService / sync queue
  → [Wrap] modalityWrapper adds mode block + notify contract reminder (voice only)
  → runner forwards to agent CLI
  → agent works (operator gardens)
  → assistant messages → sessionHandlers
  → AgentNotifyParser extracts AGENT_NOTIFY_SUMMARY
  → modeEngine transitions (e.g. executing_async → reporting → idle_warm)
  → SSE + voiceHooks push context
  → Voice speaks summary (TTS) when mode allows
```

**Acknowledgement policy (fixes Vox false start):**

1. User finishes speaking.
2. Tool invoked.
3. **Hub persists and queues** user message (exit criterion Phase 2).
4. Only then: brief ack ("Sent." / "Got it.") - optionally **hub-generated**, not LLM improvisation.
5. Transition to `executing_async`.
6. **Silence** until permission, blocker, or notify done.

**Pass-through wording:** Voice should forward user intent **without rewriting into a different task**. Dispatcher paraphrase caused drift ("workspace check" vs "what is this project about"). Modality wrapper tells the **agent** how to behave; it should not replace the user's words.

### 14.7 Being responsive to agents (when to interrupt the gardener)

Interrupt priority (highest first):

1. **Permission request** - agent blocked on tool approval; speak immediately with allow/deny prompt.
2. **`AGENT_NOTIFY_SUMMARY` with `status: blocked`** - agent needs decision or info.
3. **`AGENT_NOTIFY_SUMMARY` with `status: needs_decision`** - multiple options; speak options briefly.
4. **Send/transport failure** - queue rejected, runner offline; do not claim work started.
5. **`status: done`** - speak summary when operator would want to know work finished (respect DND later).
6. **Agent question in `await_confirm` territory** - agent asked "is that right?"; hold execution.

Do **not** interrupt for:

- Routine tool calls mid-flight
- Partial streaming tokens
- Dispatcher "helpful" check-ins
- Low-confidence re-clarification when session + user text are sufficient

This maps Vox **attention queue** to HAPI: surface sessions with `pending permission`, `blocked notify`, or `failed send` - not every idle session.

### 14.8 Check-in workflows (gardening-friendly)

Port Vox check-in detection (`_is_check_in_text` in `voice_mode_state.py`) as shared helpers. These are **read-mostly** - they should query hub state, not spawn agents unless user explicitly adds new work:

| User says (examples) | Mode transition | Action |
|----------------------|-----------------|--------|
| "What needs me?" | `report_refresh` | Summarize pending permissions + blocked sessions + last notify per focused session |
| "Where did we leave off?" | `report_refresh` | Last agent notify summary + recent user/agent exchange |
| "Read last response" | `report_refresh` | Speakable tail of last assistant message (strip contract JSON) |
| "Status?" / "Catch me up" | `report_refresh` | Same as above; cold idle adds recap preamble |

After recap, if user adds new work in same utterance, transition `align_intent` → queue send.

Future tools (Phase 3+): `getSessionStatus`, `listAttentionItems` - only if prompt injection via context updates proves insufficient.

### 14.9 Modality wrapper content (what agents see vs what user hears)

User hears: natural speech, summaries, permission prompts.

Agent sees (voice-originated turns only), adapted from `modality.py`:

- `[user said]` block with verbatim user text
- `[HAPI voice mode context]` with current `mode_state`, optional `pending_intent_digest`
- Execution policy bullets per mode (e.g. `executing_async`: milestone/blocker/done only)
- Reminder to emit `AGENT_NOTIFY_SUMMARY {"version":1,...}` on completion

Agent does **not** see dispatcher `short_state`/`long_state` rolls.

Global `AGENTS.md` rule already requires notify line format; HAPI wrapper reinforces it for voice sessions.

### 14.10 Permission and destructive work (responsive, not reckless)

Vox pattern: `approve current` → `confirm approve` (two-step). HAPI already has `processPermissionRequest` against hub permission state.

Extend for Cursor `--trust` remote mode (Phase 2 guardrails):

- Voice-triggered **mutating** tasks may require `await_confirm` + spoken playback of intent
- Destructive keywords / high-risk tool patterns port selectively from `safety.py`
- Never auto-approve from voice without explicit allow

Operator gardening implies **trust but verify**: agent stays busy on safe work; risky work waits for a nod.

### 14.11 Feedback loop: one truth, three consumers

When an assistant message lands in `sessionHandlers.ts`:

1. **Store** full message (unchanged) in SQLite
2. **Parse** `AGENT_NOTIFY_SUMMARY` if present → typed object
3. **Update** session voice mode via `modeEngine`
4. **Broadcast** SSE/session update to web/Telegram
5. **Voice** via hooks: contextual update for LLM; optional proactive TTS on `reporting` / done
6. **agent-notify** (optional): same parsed object for stop-hook TTS/tmux - single contract, multiple outputs (ACTUALSPEC §1)

Speak **notify.summary**, not dispatcher paraphrase. Strip JSON before TTS.

### 14.12 UX principles (from legit interface spec, adapted for HAPI)

Keep from CursorVox product contract:

- Command-first, not generic chatbot that sometimes sends work
- Mobile-first: large talk control, visible session, clear connection health
- Show what was heard and what happened (audit trail in UI - HAPI web can extend session view)
- Errors speakable: no session, runner offline, permission missing, send failed

Drop:

- Cursor target cards from `windowSnapshots`
- Pipecat demo as primary surface (HAPI PWA replaces)
- Dependency on CursorRemote bridge health

### 14.13 Phase mapping to gardening capabilities

| Phase | Gardener capability unlocked |
|-------|------------------------------|
| **0** (dogfood) | Can open HAPI, pick session, type/send; voice path read end-to-end |
| **1** | Hub knows mode + notify; "what needs me" can be answered from truth; completion visible in API |
| **2** | Voice send is wrapped + gated; no false "starting"; confirm before risky voice tasks |
| **3** | Full loop: speak task → garden → hear done summary; permissions interrupt reliably |
| **4** | Retire CursorVox stack; HAPI is canonical remote |

### 14.14 Dogfood acceptance matrix (adapt from CursorVox)

Each scenario must pass on HAPI before CursorVox decommission:

| # | Scenario | Pass criteria |
|---|----------|---------------|
| 1 | Cold return | After simulated 12h idle, "where did we leave off" gives recap from session, not "which project?" |
| 2 | Delegate async | Voice sends harmless task; **no speech** until done notify or permission |
| 3 | Permission interrupt | Agent requests bash; voice prompts; allow/deny works; agent continues |
| 4 | Blocked notify | Agent emits `status: blocked`; voice speaks action field; mode = blocked |
| 5 | Done notify | Agent emits `status: done`; voice speaks summary; mode → idle_warm |
| 6 | Confirm gate | Risky task enters await_confirm; spurious send blocked until confirm |
| 7 | Send failure | Runner offline → blocked spoken; **no** "starting now" |
| 8 | Check-in read-only | "What needs me" does not enqueue new agent message |
| 9 | Multi-session | Switch focus in UI; voice respects new session context |
| 10 | Cursor trust path | Document behavior when `--trust` skips per-tool approval |

Record evidence in hub logs + `~/.hapi/voice-sessions.jsonl` (via `POST /api/voice/sessions/log` on voice disconnect). Example: `docs/dogfood/2026-05-23-elevenlabs-voice-first-hello.md`.

### 14.15 Open design choices (gardening tuning)

1. **Max clarification rounds** in `align_intent` before pass-through (Vox had dispatcher loops; suggest cap at 1-2 when session bound).
2. **Proactive done speech** when voice session inactive but notify arrives (Telegram push vs later voice readback).
3. **Attention API** on HAPI: dedicated endpoint vs derive from session list + permission counts.
4. **Upstream PR order:** state contract (Phase 1) → modality wrapper (Phase 2) → `VoiceTransportProvider` + local OpenAI stack (Phase 3) - each slice reviewable without breaking default ElevenLabs path.

Default stance: **ship deterministic hub behavior first**; tune LLM phrasing second.

---

## 15. Document maintenance

When phases complete, update:

- [ ] This file (checkboxes + §10 decisions + §16 PR status)
- [ ] `~/coding/server-setup` runbook if `svc:hapi` deployed
- [ ] `~/coding/cursorvox/README.md` - add deprecation pointer to HAPI voice integration (upstream PR path)
- [ ] `~/coding/CursorRemote/README.md` - clarify IDE-legacy scope
- [ ] `docs/dogfood/*` when new voice sessions are recorded

**Do not** commit upstream submodule changes without explicit operator request.

---

## 16. Upstream PR strategy, dogfood findings, and new-agent handoff

**Audience:** New agent taking this forward with a **clean start** (fresh branch, re-implement WIP; do not assume operator's uncommitted diff is deployed).

**Canonical dogfood artifacts:**

| File | Content |
|------|---------|
| `docs/dogfood/2026-05-23-elevenlabs-voice-first-hello.md` | Hello test; handoff OK; readback failed |
| `docs/dogfood/2026-05-23-elevenlabs-subtitle-search.md` | Real feature request; handoff OK; summary never delivered |
| `docs/dogfood/*.jsonl` | Exported ElevenLabs conversation JSON (sanitized for repo) |
| `~/.hapi/voice-sessions.jsonl` | Runtime log after PR B (operator machine) |

### 16.1 Production gaps (May 2026 proxmox dogfood)

| Symptom | Evidence |
|---------|----------|
| **Handoff works** | `POST .../messages 200` after `messageCodingAgent` |
| **Readback fails** | ConvAI says "finished" but cannot summarize coding-agent output |
| **Ready hook misleads** | `formatReadyEvent` injects *"previous messages ARE the summary"* without embedding text; shows as fake `user` turn in ElevenLabs transcript |
| **Wrong agent label** | Ready text says "Claude Code" on Cursor sessions |
| **ConvAI chattiness** | "Are you still there?" during async work despite `VOICE_SYSTEM_PROMPT` silence rules |
| **No hub transcript** | Voice conversation only on ElevenLabs unless manually fetched |
| **No upstream issue** | No matching open issue on `tiann/hapi` |

### 16.2 How HAPI readback works today (and why it failed)

| Mechanism | Role |
|-----------|------|
| `voiceHooks.onMessages` | Push new coding-agent messages to ConvAI as **contextual updates** (includes text) |
| `voiceHooks.onReady` | When `session.thinking` false → `sendUserMessage(formatReadyEvent(...))` |
| `VOICE_SYSTEM_PROMPT` | Tells ConvAI to wait after tool send; summarize on updates |

**Root bug:** `onReady` asserts the summary already exists in context but **does not paste assistant text**. ConvAI hallucinates progress ("summary in the previous message") when context is empty or thin.

**Planned fixes (PR A):** `extractLastAssistantSpeakable()` + embed in `formatReadyEvent`. **Planned enhancement (PR C):** prefer optional `AGENT_NOTIFY_SUMMARY.summary` when operator agents emit it.

### 16.3 Dogfood session 1 - hello test

- **Conv ID:** `conv_1201ksawpq32evna7dcy4ksaw3eh` · 83s · "Message Coding Agent"
- **Hub session:** `9d04335d-2b90-4941-98a7-eb414823f0e0` (jellybot / Cursor)
- **Hub:** token 18:04:11, message POST 18:04:34
- **Result:** `messageCodingAgent("hello")` succeeded; user asked for summary; ConvAI had nothing substantive to report
- **Lesson:** Even trivial tasks expose ready-hook gap

### 16.4 Dogfood session 2 - subtitle search feature

- **Conv ID:** `conv_8501ksaxzm0tfv98198ar2r2t777` · 291s · "Subtitle Search Feature"
- **Hub:** token 18:26:31, message POST 18:27:35 (real jellybot feature request)
- **Flow:** User described subtitle index/search feature → ConvAI confirmed → `messageCodingAgent` → "sent" (tool obeyed)
- **Failures:**
  - ConvAI check-ins at 89s, 130s (violates async silence)
  - Ready injection at 176s with empty summary claim
  - User "yes please" for summary at 228s → never delivered; ended politely useless at 282s
- **Lesson:** Handoff production-ready; **completion reporting is not**

### 16.5 Upstream landscape

| Item | Type | Status | Relevance |
|------|------|--------|-----------|
| **[PR #640](https://github.com/tiann/hapi/pull/640)** | PR | OPEN | Codex messages → voice context; ready on completion messages. **Coordinate with PR A.** Does not fix inline ready text or Cursor. |
| **[PR #401](https://github.com/tiann/hapi/pull/401)** | PR | OPEN, conflicts, changes requested | `VOICE_BACKEND`, Gemini Live, Qwen; runtime `GET /api/voice/backend`. **Enable/track - do not reimplement.** |
| **[#462](https://github.com/tiann/hapi/issues/462)** | Issue | OPEN | Composer dictation - **not** voice-assistant flow |

### 16.5.1 Maintainer review gate - PR #401 (`tiann`, CHANGES_REQUESTED)

**tiann (2026-04-06):** *"I believe this is a good feature. Please fix the comments first."*

That means resolve **HAPI Bot** inline review threads before re-requesting review - not invent a parallel architecture. tiann has no separate inline comments; the actionable list is the bot findings on the PR head (`aa9802d` at last check).

**Must hold (maintainer coexistence contract):**

| Requirement | Why |
|-------------|-----|
| `DEFAULT_VOICE_BACKEND = 'elevenlabs'` | Hubs with only `ELEVENLABS_API_KEY` must not route to Gemini/Qwen |
| ElevenLabs code paths untouched | Zero regression on default install |
| ElevenLabs prompt/language unchanged | Chinese prompt block must **not** leak into ElevenLabs config; use backend-specific prompts |
| WebSocket proxies JWT-gated | `/api/voice/gemini-ws` and `/api/voice/qwen-ws` require hub JWT before upgrade |
| No provider secrets to browser | Token endpoints return proxied `wsUrl` only; DashScope/Gemini keys stay server-side |
| Split upstream vs client WS URLs | `*_UPSTREAM_WS_URL` server-only; browser always gets `/api/voice/*-ws` |
| Voice button gated until registered | `onRegistered` after lazy chunk mounts + `registerVoiceSession()` - not just backend discovery |
| `HAPI_PUBLIC_URL` / request origin for proxy URLs | Remote browsers must not get `ws://localhost:...` |
| Sequential Gemini tool calls | No `Promise.all` on shared permission/session state |
| AudioWorklet graph pulls frames | Worklet connected through zero-gain sink to destination |
| Mobile AudioContext in user gesture | Create/resume playback context at start of click handler |
| Cleanup on failed starts | Close leaked `AudioContext` on throw paths |
| No `skipWaiting`/`clientsClaim` in SW | Avoid lazy-chunk hash mismatch mid-session after deploy |
| Debug-guard voice tool logs | `messageCodingAgent` logs behind `VOICE_CONFIG.ENABLE_DEBUG_LOGGING` |

**Claimed fixed by author (verify on rebase):** Qwen WS auth, default backend revert, proxy URL split, ElevenLabs language split, voice-button readiness, ws URL origin, audio graph, sequential tools, SW revert, debug logging, mic mute on start.

**Still open per HAPI Bot at last head (must confirm or fix before merge):**

| Finding | File area | Notes |
|---------|-----------|-------|
| Gemini unmutes user after `turnComplete` | `GeminiLiveVoiceSession.tsx` | Must respect user mute across model speech (barge-in mute ≠ user mute) |
| Failed starts leak `AudioContext` | Gemini + Qwen sessions | `try/catch` + `cleanup()` on all early exits |
| Composer Enter-to-send inverted | `HappyComposer.tsx` | Bot flags as unrelated regression; author claims separate intentional UX change - **needs tiann ruling**, not assumption |
| Gemini setup message dropped under proxy backpressure | `server.ts` / Gemini WS | Queue initial setup if upstream slow |
| Qwen stuck in `connecting` on setup error after `session.created` | `QwenVoiceSession.tsx` | Reject promise + surface error |
| Merge conflicts with current `tiann/main` | whole PR | Rebase required |

**Our PR A/B/C:** Do not bundle unrelated composer or SW changes. Stack on #401 only after above gate passes.

### 16.5.2 Maintainer review gate - PR #640

**tiann:** No review yet (OPEN, no CHANGES_REQUESTED).

**HAPI Bot (initial review) - must fix before merge:**

| Finding | Issue | Required fix |
|---------|-------|--------------|
| Historical ready replay | `SessionChat.tsx` scans `newMessages` including hydrated history | Move ready detection to **live SSE** `message-received` path only; never fire `onReady` for refetched/old `ready` / `task_complete` rows |

**Overlap with our PR A:** #640 improves Codex message formatting + ready **trigger**; PR A fixes ready **payload** (inline assistant text). Prefer: merge #640 first or one coordinated PR; do not duplicate Codex formatter work in PR A.

**Does not replace PR A:** #640 does not embed assistant text in `formatReadyEvent` or fix Cursor sessions.

### 16.6 Upstream PR series (merge-shaped)

Each PR: **default ElevenLabs behavior unchanged** when env unset.

#### PR A - Voice completion readback (ship first)

- `formatReadyEvent(sessionId, lastAssistantText?)` embeds assistant text; agent-neutral wording
- `voiceHooks.onReady` uses `extractLastAssistantSpeakable(messages)`
- Tests: `contextFormatters.test.ts`
- Coordinate with PR #640

#### PR B - ElevenLabs conversation archive

- `hub/src/voice/elevenLabsConversationLog.ts`
- `POST /api/voice/sessions/log`
- Web: store `conversationId` on start, archive on disconnect
- Log path: `{HAPI_HOME}/voice-sessions.jsonl`

#### PR C - Optional AGENT_NOTIFY parsing

- `shared/src/agentNotify.ts`; hook `sessionHandlers.ts`
- Voice prefers notify `summary` when present
- **Not** a HAPI default; **not** required for all users
- Upstream docs: "optional convention for custom agent rules"

#### PR D - Mode state + modality wrapper (later)

- `voiceMode.ts`, `modalityWrapper.ts`, `await_confirm` gating
- Operator fork or post A-C if maintainer wants scope

#### PR E - Local OpenAI backend (after #401)

- `VOICE_BACKEND=local-openai` using #401's switcher
- Speaches STT + local chat tools + Chatterbox TTS
- **Not** a parallel architecture

### 16.7 PR #401 - enable and extend (do not reinvent)

PR #401 adds:

```bash
VOICE_BACKEND=elevenlabs   # default, unchanged
VOICE_BACKEND=gemini-live  # Google Live API, function calling
VOICE_BACKEND=qwen-realtime
GET /api/voice/backend     # runtime discovery, no Vite rebuild
```

**Recommendation:**

1. Rebase `Overbaker:feat/pluggable-voice-backend` onto `tiann/main`; resolve merge conflicts
2. Walk **§16.5.1 checklist** against PR head; fix or verify each HAPI Bot thread; re-request tiann review
3. On Composer Enter change: confirm with tiann whether it stays in #401 or splits to separate PR (bot treats it as blocker)
4. Stack PR A/B/C on `VoiceBackendSession` after #401 merges
5. Use **Gemini Live** for early non-ElevenLabs dogfood (free tier, tools) while local stack waits on PR E
6. Verify ElevenLabs remains sole default when env unset (`DEFAULT_VOICE_BACKEND`)

### 16.8 Local WIP status (operator clone, May 2026)

**Not committed. Not running on proxmox** (hub since 15:29 without restart; web not rebuilt).

| Path | Target PR |
|------|-----------|
| `web/src/realtime/hooks/contextFormatters.ts` | A |
| `web/src/realtime/hooks/voiceHooks.ts` | A, C |
| `hub/src/voice/elevenLabsConversationLog.ts` | B |
| `hub/src/web/routes/voice.ts` | B |
| `web/src/realtime/RealtimeSession.ts` | B |
| `web/src/realtime/RealtimeVoiceSession.tsx` | B |
| `web/src/api/client.ts` | B |

New agent: **re-implement on fresh branch** from current upstream; use above as reference only.

### 16.9 New-agent checklist

- [ ] Read §14 (gardening model) and §16 (this section)
- [ ] Read `docs/dogfood/*`
- [ ] `git pull` on `tiann/hapi/main`
- [ ] Review PR #640 and #401 (**§16.5.1-16.5.2 maintainer gates**)
- [ ] Implement PR A + tests; `bun run test` + `bun typecheck:web`
- [ ] Re-dogfood subtitle-search scenario; verify ElevenLabs transcript shows inline assistant text in ready injection
- [ ] Open upstream PR with conv IDs; note AGENT_NOTIFY is opt-in in PR C description
- [ ] PR B, then PR C, then help on #401, then PR E

### 16.10 Reproduction commands

```bash
cd ~/coding/hapi/hub && bun run dev
cd ~/coding/hapi/web && bun run dev
# Voice session → delegate task → wait for agent → ask for summary

curl -H "xi-api-key: $ELEVENLABS_API_KEY" \
  "https://api.elevenlabs.io/v1/convai/conversations?agent_id=$ELEVENLABS_AGENT_ID"
```

Suggested Git workflow:

```bash
cd ~/coding/hapi
git fetch origin
git checkout main && git pull origin main

# Option 1: PR A only (smallest)
git checkout -b fix/voice-ready-inline-summary

# Option 2: help upstream #401 first
gh pr checkout 401 --repo tiann/hapi
# resolve conflicts, address tiann review, then stack PR A on top
```

Open PR with: dogfood conv IDs, **"default behavior unchanged"** regression note, PR #640/#401 relationship, and for PR C explicit **AGENT_NOTIFY is opt-in user agent convention**.

**Explicit non-goals for upstream series:** stateful voice dispatcher; required AGENT_NOTIFY for all users; breaking ElevenLabs default; CursorVox/CursorRemote coupling; Docker/systemd in same PRs.
