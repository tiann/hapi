# Plan: Voice personality and paralinguistic configuration

**Status:** Draft  
**Date:** 2026-05-27  
**Related:** `voice-selection-all-backends.md`, `self-bootstrapping-config.md` Phase 3, PR #692

---

## Goal

Go beyond which voice is used to configure *how* each voice agent engages: speaking pace, emotional
expressiveness, personality framing, and — where APIs allow — fine-grained paralinguistic controls.
Different backends expose very different levers; the UI should surface what's real and skip what
isn't.

---

## What each backend actually exposes

### ElevenLabs (richest controls)

ElevenLabs has the most knobs, set in agent config and overridable per-conversation via
`conversation_config_override.tts`:

| Parameter | Type | Range | Effect |
|-----------|------|-------|--------|
| `stability` | float | 0.0–1.0 | Lower = more emotional/dynamic; higher = more consistent but can be monotonous. ElevenLabs recommends 0.30–0.50 for expressive delivery |
| `similarity_boost` | float | 0.0–1.0 | How closely output matches the training voice. Higher = cleaner but less flexible |
| `style` | float | 0.0–1.0 | Exaggerates the voice's natural style. 0 = neutral; higher = more dramatic. Costs extra compute at higher values |
| `use_speaker_boost` | bool | — | Further boosts similarity to original speaker |
| `speed` | float | 0.7–1.2 | Speaking rate. 0.9–1.1 recommended for natural conversation; default 1.0 |

**There is no explicit emotion enum** — emotional affect emerges from the combination of
`stability` and `style`. ElevenLabs' recommended "emotional" preset: stability 0.35,
similarity_boost 0.75, style 0.35, speaker_boost on.

**System prompt** is the primary lever for personality and engagement style. Controls:
- Role, persona, name
- Tone (formal, casual, warm, direct)
- Engagement pattern (proactive vs reactive, how much it elaborates)
- Response length/conciseness
- When to ask clarifying questions vs just act
- Dynamic variables allow runtime injection (e.g. current session name, user name) without
  separate agents

**Per-conversation override:** all of the above can be overridden when minting the conversation
token, without changing the underlying agent config. Useful for context-specific personality
shifts (e.g. more formal when a permission approval is pending).

---

### Gemini Live (minimal direct controls)

Gemini Live exposes very few paralinguistic API parameters:

| Parameter | Where | Notes |
|-----------|-------|-------|
| `voice_name` | `speech_config.voice_config.prebuilt_voice_config.voice_name` | Selects prebuilt voice |
| (none) | — | No speaking rate, pitch, or emotion fields in the Live API |

**Affective dialog** is available — the model reads the user's emotional tone from audio and adapts
its response style — but you cannot *prescribe* an emotional target via API parameters. It's
responsive, not configurable.

**System prompt** is the primary (and essentially only) lever for personality. It reliably affects:
- Response tone and register
- Verbosity
- Personality framing ("be warm and encouraging", "be terse and direct")
- Whether the model elaborates or waits to be asked

The Gemini TTS API (separate from Live) supports SSML-style prosody tags for pace/tone, but these
are **not available in the Live/realtime endpoint** as of 2026-05.

**Takeaway for UI:** for Gemini, the only exposed controls worth surfacing are voice selection
(see `voice-selection-all-backends.md`) and system prompt customisation. No sliders needed.

---

### Qwen Realtime (instruction-based controls)

Qwen takes a different approach — paralinguistic control is via natural language instructions
rather than numeric parameters:

| Control | Mechanism | Example |
|---------|-----------|---------|
| Speaking rate | In-turn instruction | "speak faster", "speak slower" |
| Volume | In-turn instruction | "speak louder" |
| Emotion | In-turn instruction | "speak cheerfully", "speak warmly" |
| Voice | `session.update` → `session.voice` field | "Mia", "Tina", etc. |

**Emotion recognition:** Qwen recognises 7 input emotions from the user's audio (surprised, neutral,
happy, sad, disgusted, angry, fearful) and can adapt accordingly — similar to Gemini's affective
dialog, but with a named taxonomy.

**55 voices available** (47 multilingual + 8 dialect), selected via `session.update`.
Known English-suitable voices: Mia (default), Tina, Cherry, Chelsie, Serena, Ethan.

**System prompt** influences engagement style. Instruction-based emotion/pace control means the
system prompt can include standing instructions: "speak at a relaxed, unhurried pace" or "respond
with warmth and encouragement" — and Qwen will apply this without a per-parameter API call.

**Takeaway for UI:** for Qwen, surface voice selection and a system prompt editor. Consider a
small set of preset "personality modes" that translate to natural language instructions baked into
the prompt (see Presets section below).

---

## Settings UI design

### Location

`Settings → Voice Assistant` — extend the existing section rather than adding a new tab.
Organisation within the section:

```
Voice Assistant
  ├─ Backend           [picker — Phase 1 of self-bootstrapping-config.md]
  ├─ Voice             [per-backend picker — voice-selection-all-backends.md]
  ├─ Personality       [new — this plan]
  │    ├─ Preset       [dropdown]
  │    └─ Custom prompt [expandable textarea]
  └─ Advanced          [collapsible — ElevenLabs-only sliders]
       ├─ Stability
       ├─ Expressiveness (style)
       ├─ Speaking rate
       └─ Similarity boost
```

---

### Personality presets

A small set of named presets that configure the system prompt additions and (for ElevenLabs)
the paralinguistic parameters together. Presets are backend-aware — they apply what each
backend can actually do.

Suggested initial set:

| Preset | Feel | ElevenLabs params | Prompt addition |
|--------|------|-------------------|-----------------|
| **Balanced** (default) | Warm but focused | stability 0.5, style 0.1, speed 1.0 | (none — base prompt only) |
| **Expressive** | Energetic, animated | stability 0.35, style 0.35, speed 1.05 | "Be enthusiastic and expressive. Vary your pace and energy." |
| **Calm** | Measured, reassuring | stability 0.75, style 0.0, speed 0.95 | "Speak in a calm, measured way. Pause thoughtfully." |
| **Direct** | Terse, efficient | stability 0.65, style 0.05, speed 1.1 | "Be concise and direct. Skip pleasantries unless asked." |
| **Custom** | User-defined | user values | user prompt |

For Gemini and Qwen, presets only affect the prompt addition (no sliders to set). The preset
label still appears — it just means the prompt style, not the audio parameters.

---

### System prompt customisation

A textarea in Settings lets the operator append to (not replace) the base `VOICE_SYSTEM_PROMPT`:

```
[Base VOICE_SYSTEM_PROMPT — not editable]

[Personality preset addition — auto-filled, editable]

[Operator notes — free-form]
```

**Storage:** localStorage initially (`hapi-voice-custom-prompt`). Phase 3 of
`self-bootstrapping-config.md` moves this to the SQLite config table so it persists across
devices.

**Scope:** custom prompt applies to all backends equally — it's appended to instructions before
the session starts. Per-backend prompt overrides are a later enhancement if needed.

---

### Advanced controls (ElevenLabs only)

Show a collapsible "Advanced" section only when ElevenLabs is the active backend.
Hide entirely for Gemini and Qwen — don't show grayed-out sliders that do nothing.

```
Advanced (ElevenLabs only)
  Stability         [slider 0–1]  default: 0.5
  Expressiveness    [slider 0–1]  default: 0.1   (maps to `style`)
  Speaking rate     [slider 0.7–1.2]  default: 1.0
  Similarity boost  [slider 0–1]  default: 0.75
  [ ] Speaker boost              default: off
```

Label "Expressiveness" not "Style" — more intuitive. Tooltip explains the tradeoff.
"Similarity boost" and "Speaker boost" grouped together with a note that these are voice-specific
and may sound different with different voices.

**Storage:** localStorage per-backend (`hapi-voice-el-stability` etc.) or a single JSON object
(`hapi-voice-el-settings`). Phase 3 moves to DB.

---

## Hub changes

**`hub/src/web/routes/voice.ts`** — ElevenLabs token endpoint

The existing `POST /voice/token` calls `getOrCreateAgentIdForVoice()`. Extend to accept
paralinguistic overrides and pass them as `conversation_config_override.tts`:

```typescript
// New optional fields on token request body:
voice_settings?: {
    stability?: number
    similarity_boost?: number
    style?: number
    use_speaker_boost?: boolean
    speed?: number
}
```

Hub passes these through to the ElevenLabs `POST /v1/convai/conversation/token` call.

For Gemini and Qwen no hub changes needed — voice params go through the frontend session config
and the WebSocket proxy forwards them as-is.

---

## Shared prompt infrastructure

The custom prompt append should flow through the existing `sendContextualUpdate` /
`updateInstructions` paths — not require new hub endpoints:

- ElevenLabs: include in `conversation_config_override.agent.prompt.prompt` when minting token
- Gemini: include in `systemInstruction` in `BidiGenerateContentSetup`
- Qwen: include in `instructions` in `session.update`

`VoiceSessionConfig` gains a `customPrompt?: string` field alongside `voiceName?`.
`VoiceBackendSession` reads from localStorage and passes through.

---

## Files touched

| File | Change |
|------|--------|
| `shared/src/voice.ts` | `VOICE_SYSTEM_PROMPT` stays as base; `buildGeminiLiveConfig()` accepts `customPrompt?` |
| `web/src/realtime/types.ts` | Add `voiceName?`, `customPrompt?`, `voiceSettings?` to `VoiceSessionConfig` |
| `web/src/realtime/GeminiLiveVoiceSession.tsx` | Pass `customPrompt` into system instruction |
| `web/src/realtime/QwenVoiceSession.tsx` | Pass `customPrompt` into `session.update` instructions |
| `web/src/realtime/RealtimeVoiceSession.tsx` / token call | Pass `voice_settings` override |
| `web/src/realtime/VoiceBackendSession.tsx` | Read all settings from localStorage, pass in config |
| `web/src/routes/settings/index.tsx` | Preset picker, custom prompt textarea, ElevenLabs sliders |
| `hub/src/web/routes/voice.ts` | Accept and forward `voice_settings` in token request |

---

## What the Qwen instruction-based approach means for UI

For Qwen, "speaking faster" or "cheerfully" is a natural language instruction, not a slider.
The Personality preset system handles this cleanly — the "Expressive" preset for Qwen just
injects "Be enthusiastic and expressive. Vary your pace and energy." into the system prompt,
which Qwen will follow. No need to expose a "send a message saying speak faster" control.

---

## Open questions

1. **ElevenLabs per-conversation override** — does overriding `agent.prompt.prompt` in the token
   request fully replace or append to the agent's configured prompt? Verify before implementing
   — may need to fetch the agent's base prompt and concatenate.
2. **Gemini SSML in Live** — Google may add prosody controls to Live API in future. Monitor
   release notes; the UI should be easy to extend if sliders become meaningful.
3. **Qwen full voice personality descriptions** — the 55-voice list with personality descriptions
   is in Chinese docs. Worth translating/curating before shipping the picker.
4. **Preset persistence** — localStorage for now; Phase 3 of self-bootstrapping-config.md moves
   settings to SQLite. Design the storage shape so migration is a copy, not a restructure.
5. **Per-session vs persistent** — should personality settings apply to all future sessions or
   be overridable per-session-start? Start with persistent (stored settings always apply);
   per-session override is a later enhancement.
