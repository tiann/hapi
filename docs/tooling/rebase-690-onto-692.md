# Rebase PR #690 onto post-#692 main

## Context

PR #690 (`feat(voice): dynamic settings voice picker`) and PR #692
(`feat(voice): pluggable voice backend with Gemini Live & Qwen Realtime`) share
several files. #692 is intended to merge first. This document tells you exactly
what to do to land #690 cleanly afterward.

**The good news:** the two PRs are mostly complementary. #692 adds multi-backend
infrastructure (Gemini Live, Qwen), #690 adds a voice picker UI for ElevenLabs
voices. They touch the same files in different places, not the same lines.

---

## Branch setup

```bash
# Work in the existing worktree for #690
cd ~/coding/hapi           # or wherever feat/voice-picker-upstream lives
git branch --show-current  # confirm: feat/voice-picker-upstream

# Fetch the merged upstream
git fetch upstream
git rebase upstream/main
```

The rebase will likely pause on conflicts in several files. Work through them
file by file using the guide below.

---

## File-by-file conflict guide

### 1. `hub/src/web/routes/voice.ts` — main conflict zone

**What #692 brought:**
- `GET /voice/backend` — returns configured backend type
- `GET /voice/gemini-token` — proxies Gemini API key, returns WS proxy URL
- `POST /voice/qwen-token` — Qwen/DashScope token
- `buildVoiceWsUrl()` helper (uses URL API to avoid double-slash on trailing HAPI_PUBLIC_URL)
- Restructured `POST /voice/token` (ElevenLabs only, simpler — no voice-agent mapping)

**What #690 adds on top:**
- `voiceId` field on the token request schema
- `parseVoiceAgentMap()` — parses `ELEVENLABS_VOICE_AGENT_MAP` env var
- `getOrCreateAgentIdForVoice()` — per-voice ElevenLabs agent creation/lookup
- `getVoiceAgentName()` — generates names like `"Hapi Voice Assistant [voice:voiceId]"`
- `createNamedHapiAgent()` — creates agents with custom names and voice IDs
- `findHapiAgent()` enhanced to accept optional `agentName`
- Enhanced `POST /voice/token` with multi-fallback voice selection logic
- `GET /voice/voices` — returns user's ElevenLabs voice list with metadata
- `POST /voice/telemetry` — voice analytics events

**Strategy:** Keep everything #692 added. Bolt #690's additions onto it:
- The enhanced token endpoint logic wraps around #692's simpler version
- The `/voice/voices` and `/voice/telemetry` endpoints are additive (no conflict)
- `buildVoiceWsUrl()` from #692 is correct — do not replace it

---

### 2. `hub/src/web/routes/voice.test.ts` — additive

#692 has its own test additions. #690 adds a comprehensive suite for:
- `GET /voice/voices` (auth, API key handling, field mapping)
- `POST /voice/token` with voice-specific agent logic (mapping preference, fallbacks)

These test different things. Accept both test blocks. The auth middleware pattern
in #690's tests should match how #692 wired auth — check the route registration
in `hub/src/web/server.ts` to confirm the middleware order is the same.

---

### 3. `shared/src/voice.ts` — keep #692 version

**#692 adds** (all net-new, keep everything):
- `VOICE_CHINESE_LANGUAGE_BLOCK`
- `VoiceToolDefinition`, `GeminiLiveConfig` interfaces
- `buildGeminiLiveConfig(language?)`, `buildGeminiLiveFunctionDeclarations()`
- Constants: `GEMINI_LIVE_MODEL`, `QWEN_REALTIME_MODEL`, `QWEN_REALTIME_VOICE`, `DEFAULT_VOICE_BACKEND`
- `VoiceBackendType` = `'elevenlabs' | 'gemini-live' | 'qwen-realtime'`

**#690's `VOICE_SYSTEM_PROMPT`** is an older, shorter version. **#692's version is
more complete** (has CRITICAL RULE, Tool Usage section, First Interaction section,
identity guardrails). **Keep #692's prompt, discard #690's.**

The `VOICE_FIRST_MESSAGE` constant is identical in both — no conflict.

---

### 4. `web/src/api/voice.ts` — additive

**#692 adds:** `fetchQwenToken()`, `fetchGeminiToken()`, backend-related types and
helpers (ElevenLabs agent management moved server-side).

**#690 adds:** `fetchVoices()`, `sendVoiceTelemetry()`, `VoiceTokenRequest` with
`voiceId` field.

**Strategy:** Keep #692's structure. Add these two functions from #690:
```typescript
export async function fetchVoices(api: ApiClient): Promise<{ voices: VoiceInfo[] }> { ... }
export async function sendVoiceTelemetry(api: ApiClient, event: TelemetryEvent): Promise<void> { ... }
```
Check that `VoiceInfo` and `TelemetryEvent` types are defined (they may be in
`web/src/lib/voices.ts` which #690 creates — see below).

---

### 5. `web/src/api/client.ts` — additive

**#692 adds:** `fetchVoiceBackend()`, `fetchQwenToken()`, `fetchGeminiToken()`.
Also `fetchVoiceToken()` already accepts `voiceId?: string` (compatible with #690).

**#690 adds:** `fetchVoices()`, `sendVoiceTelemetry()`.

**Strategy:** Accept #692's additions. Add #690's two missing methods. No structural
conflict — they call different endpoints.

---

### 6. `web/src/lib/locales/en.ts` — additive, no conflict

**#692 adds:**
```typescript
'settings.voice.proactive': 'Start voice session with summary',
'settings.voice.proactive.description': '...',
```

**#690 adds:**
```typescript
'settings.voice.voice': 'Voice',
'settings.voice.voiceDefault': 'Default',
```

Keep both groups. They are different keys.

---

### 7. `web/src/lib/locales/zh-CN.ts` — same as en.ts

Both sets of keys are additive. Keep both.

---

### 8. `web/src/routes/settings/index.tsx` — main UI merge

**#692 adds:**
- Proactive/reactive toggle (localStorage `hapi-voice-proactive`)
- Language selector for voice

**#690 adds:**
- Voice picker UI with dynamic voice list, audio preview controls
- `PlayIcon` component
- `isVoiceOpen` state, voice selection state
- Calls `fetchVoices()` on mount (ElevenLabs API)
- Passes `voiceId` to `fetchVoiceToken()` via context or direct call
- Telemetry integration via `sendVoiceTelemetry()`

**Strategy:**
1. Keep #692's proactive toggle and language selector as-is
2. Add #690's voice picker as a separate settings section — but make it
   **backend-aware**, not ElevenLabs-only (see section below)
3. The picker should show for all three backends, with each surfacing
   its own voice list

**Do NOT gate the picker to ElevenLabs only.** All three backends have
voice options that users should be able to choose:

| Backend | Voice source | Current default |
|---------|-------------|-----------------|
| ElevenLabs | Dynamic from `GET /voice/voices` (API) | env default |
| Gemini Live | Static list of prebuilt voices | `'Aoede'` (hardcoded) |
| Qwen Realtime | Static list of available voices | `'Mia'` (hardcoded in `QWEN_REALTIME_VOICE`) |

**Correct architecture:**
1. Add `voiceName?: string` to `VoiceSessionConfig` (in `web/src/realtime/types.ts`,
   added by #692)
2. Each backend session reads it:
   - `GeminiLiveVoiceSession`: pass to `prebuiltVoiceConfig.voiceName` instead of
     hardcoded `'Aoede'`
   - `QwenVoiceSession`: pass to `session.update` `voice` field instead of
     hardcoded `QWEN_REALTIME_VOICE`
   - `RealtimeVoiceSession` (ElevenLabs): already passes `voiceId` to
     `fetchVoiceToken()` — keep as-is
3. The picker in settings renders different options depending on active backend:
   - ElevenLabs: dynamic fetch from `fetchVoices()`
   - Gemini: static list — known prebuilt voices are:
     `Aoede, Charon, Fenrir, Kore, Puck` (plus any others in the Gemini Live docs)
   - Qwen: static list — check DashScope docs for available voice IDs
4. Selected voice is stored in a per-backend localStorage key
   (e.g. `hapi-voice-gemini`, `hapi-voice-qwen`, `hapi-voice-elevenlabs`) so
   switching backends doesn't clobber each other's selection

---

### 9. `web/src/realtime/RealtimeVoiceSession.tsx` — verify only

Both versions handle ElevenLabs only and should be compatible. Confirm #690's
version doesn't accidentally remove the multi-backend registration logic #692 added
(the `VoiceBackendSession` wrapper that switches between ElevenLabs / Gemini / Qwen).
If #690's version of this file predates that wrapper, **keep #692's version** and
only apply any ElevenLabs-specific changes #690 made on top.

---

### 10. New files from #690 (no conflict, just verify they land)

- `web/src/lib/voices.ts` — voice type definitions, `VOICES` constant, `getFallbackVoices()`
- `web/src/lib/voices.test.ts` — unit tests for voices lib
- `web/src/lib/voice-context.tsx` — React context for voice selection

These files don't exist in #692's tree. They should apply cleanly. After rebase,
verify they compile (`bun run build` in `web/`).

---

## After resolving all conflicts

```bash
# Verify it builds
cd web && bun run build && cd ..

# Run tests
bun test hub/src/web/routes/voice.test.ts
bun test web/src/lib/voices.test.ts

# Force-push the rebased branch
git push origin feat/voice-picker-upstream --force-with-lease
```

Then check PR #690 — GitHub will update the diff automatically. Run
`/verification-before-completion` and `/requesting-code-review` before declaring
the rebase done.

---

## Things to watch

**ElevenLabs-specific agent logic stays server-side.**
`ELEVENLABS_VOICE_AGENT_MAP`, `getOrCreateAgentIdForVoice`, `createNamedHapiAgent` —
all of this is ElevenLabs infrastructure. Guard it at the route level in
`hub/src/web/routes/voice.ts` so it only runs when `VOICE_BACKEND=elevenlabs`.
The `/voice/voices` endpoint is also ElevenLabs-only — return 404 or an empty list
when the backend is Gemini or Qwen rather than calling the ElevenLabs API.

**Voice selection is a UI concern for all three backends.**
The picker in the settings UI should work regardless of backend. Only the *data
source* for the voice list differs (dynamic API vs static constants). The
`VoiceSessionConfig.voiceName` field carries the selection through to whichever
session implementation is active.

**Gemini prebuilt voice names** — at time of writing the available voices are
`Aoede, Charon, Fenrir, Kore, Puck`. Verify against the Gemini Live API docs before
hardcoding the static list; Google adds voices periodically.

**Qwen voice IDs** — check DashScope realtime docs for the current list. `Mia` is
the current default set in `QWEN_REALTIME_VOICE` in `shared/src/voice.ts`.
