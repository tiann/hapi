# Plan: Voice selection for all backends (Gemini, Qwen, ElevenLabs)

**Status:** Draft  
**Date:** 2026-05-27  
**Supersedes:** `docs/tooling/rebase-690-onto-692.md` §8 (voice picker backend-awareness section)  
**Related:** PR #690 (ElevenLabs voice picker), PR #692 (pluggable backends), `self-bootstrapping-config.md` Phase 1

---

## Goal

PR #690 added a voice picker for ElevenLabs voices. That picker should work for all three backends —
each surfacing its own voice list (dynamic for ElevenLabs, static for Gemini and Qwen) — with
selections stored independently so switching backends doesn't clobber each other's choice.

---

## Available voices per backend

### ElevenLabs

5,000+ voices fetched dynamically from `GET /api/voice/voices` (already implemented in PR #690).
Selection stored in localStorage as before. No change needed here beyond backend-awareness in the UI.

### Gemini Live

5 prebuilt voices available in the Live API (30 HD voices across 24 languages total, but only these
are documented for the Live/realtime endpoint):

| Voice | Character |
|-------|-----------|
| `Puck` | Conversational, friendly — good default |
| `Charon` | Deep, authoritative |
| `Kore` | Neutral, professional |
| `Fenrir` | Warm, approachable |
| `Aoede` | (documented; affect not specified in Live API docs) |

Current hardcoded default: `Aoede` (in `buildGeminiLiveConfig()`). Should become user-selectable.

Voice set via `speech_config.voice_config.prebuilt_voice_config.voice_name` in the session config
sent to Google's BidiGenerateContent endpoint.

### Qwen Realtime

55 voices available (47 multilingual + 8 dialect-specific). Known/confirmed English-accessible voices:

| Voice | Notes |
|-------|-------|
| `Mia` | Current default (`QWEN_REALTIME_VOICE` in `shared/src/voice.ts`) |
| `Tina` | |
| `Cherry` | |
| `Chelsie` | |
| `Serena` | |
| `Ethan` | |

Full list is in DashScope docs (primarily Chinese). Verify and expand this list before shipping.

Voice set via `session.voice` field in `session.update` event.

---

## Architecture changes

### 1. `VoiceSessionConfig` — add `voiceName?`

In `web/src/realtime/types.ts` (added by PR #692):

```typescript
export interface VoiceSessionConfig {
    language?: string
    initialContext?: string
    voiceName?: string   // NEW — passed through to each backend session
}
```

### 2. Session implementations read `voiceName`

**`GeminiLiveVoiceSession.tsx`**

Replace hardcoded `'Aoede'` in `buildGeminiLiveConfig()` call:

```typescript
// Before:
const config = buildGeminiLiveConfig(sessionConfig.language)

// After:
const config = buildGeminiLiveConfig(sessionConfig.language, sessionConfig.voiceName)
```

Update `buildGeminiLiveConfig()` in `shared/src/voice.ts` to accept and use `voiceName`:

```typescript
export function buildGeminiLiveConfig(language?: string, voiceName?: string): GeminiLiveConfig {
    return {
        // ...existing config...
        speechConfig: {
            voiceConfig: {
                prebuiltVoiceConfig: {
                    voiceName: voiceName ?? 'Aoede'
                }
            }
        }
    }
}
```

**`QwenVoiceSession.tsx`**

Replace hardcoded `QWEN_REALTIME_VOICE` in `this.currentSessionConfig`:

```typescript
// In startSession(), when building currentSessionConfig:
voice: config.voiceName ?? QWEN_REALTIME_VOICE,
```

**`RealtimeVoiceSession.tsx` (ElevenLabs)**

Already passes `voiceId` to `fetchVoiceToken()`. Wire `voiceName` through:

```typescript
// voiceName is the ElevenLabs voice ID for this backend
await fetchVoiceToken(this.api, { voiceId: config.voiceName })
```

### 3. Per-backend localStorage keys

Store selections independently so switching backends doesn't reset another backend's choice:

```typescript
const VOICE_STORAGE_KEYS = {
    'elevenlabs': 'hapi-voice-elevenlabs',
    'gemini-live': 'hapi-voice-gemini',
    'qwen-realtime': 'hapi-voice-qwen',
} as const
```

Current `hapi-voice-id` key (ElevenLabs-only from PR #690) migrates to `hapi-voice-elevenlabs`
on first load — or read both for backwards compatibility.

### 4. `VoiceBackendSession` passes selection through

`VoiceBackendSession.tsx` reads the active backend's localStorage key and includes `voiceName`
when calling `session.startSession(config)`.

---

## Settings UI changes (`web/src/routes/settings/index.tsx`)

The voice picker section from PR #690 becomes backend-aware:

**ElevenLabs backend active:**
- Show existing dynamic picker (fetches from `/api/voice/voices`)
- Preview controls remain
- Clone badge remains

**Gemini Live backend active:**
- Show static picker with 5 voices
- No preview (Google doesn't expose voice preview URLs)
- Show character description next to each voice name

**Qwen Realtime backend active:**
- Show static picker with known voices
- No preview
- Note if full voice list is unavailable (link to DashScope docs)

**If only one backend configured (single voice available):**
- Hide picker entirely — no point showing a list of one

**Backend picker integration:**
- If multiple backends are configured, show backend picker first (Phase 1 of
  `self-bootstrapping-config.md`), then voice picker for the selected backend
- Voice picker updates when backend selection changes

---

## Hub changes

**`hub/src/web/routes/voice.ts`**

`GET /voice/voices` is currently ElevenLabs-only. When backend is Gemini or Qwen, return 404 or
an empty list rather than attempting to call the ElevenLabs API. Gate by active backend or accept
a `?backend=` query param.

Alternatively: add `GET /voice/voices/gemini` and `GET /voice/voices/qwen` that return the static
lists server-side (easier to keep up to date without a web rebuild).

---

## Files touched

| File | Change |
|------|--------|
| `shared/src/voice.ts` | `buildGeminiLiveConfig()` accepts `voiceName?` |
| `web/src/realtime/types.ts` | Add `voiceName?` to `VoiceSessionConfig` |
| `web/src/realtime/GeminiLiveVoiceSession.tsx` | Pass `voiceName` through |
| `web/src/realtime/QwenVoiceSession.tsx` | Pass `voiceName` through |
| `web/src/realtime/RealtimeVoiceSession.tsx` | Wire `voiceName` as `voiceId` |
| `web/src/realtime/VoiceBackendSession.tsx` | Read localStorage, pass `voiceName` in config |
| `web/src/routes/settings/index.tsx` | Backend-aware voice picker UI |
| `hub/src/web/routes/voice.ts` | Guard `/voice/voices` by backend |

---

## PR strategy

This is a natural follow-on to PR #690. Two options:

**Option A:** Rebase PR #690 onto post-#692 main and extend in-place. The rebase guide
(`docs/tooling/rebase-690-onto-692.md`) covers the conflict resolution; extend the result with
the Gemini/Qwen picker work described here.

**Option B:** Merge PR #690 as ElevenLabs-only first, then open a new PR for multi-backend voice
selection. Cleaner review surface but more coordination.

Option A is preferred if PR #690 hasn't been reviewed yet — less total diff for the reviewer.

---

## Open questions

1. **Qwen full voice list** — need to verify all 55 voices and which are English-suitable.
   Check DashScope console or Chinese docs before hardcoding the static list.
2. **Gemini voice additions** — Google adds voices periodically. Consider fetching from
   a Gemini voices endpoint if one exists, rather than hardcoding.
3. **Voice preview for Gemini/Qwen** — not available via API. Could generate a short
   hub-side TTS sample on demand if worth the complexity.
4. **Backwards compatibility** — `hapi-voice-id` → `hapi-voice-elevenlabs` migration.
