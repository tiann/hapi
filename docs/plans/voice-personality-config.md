# Plan: Voice personality and paralinguistic configuration

**Status:** Draft  
**Date:** 2026-05-27  
**Goal:** Make long-session AI voice feel as natural, warm, and pleasing as possible — a command
centre experience where listening never becomes fatiguing.  
**Related:** `voice-selection-all-backends.md`, `self-bootstrapping-config.md` Phase 3, PR #692

---

## TL;DR capability table

| Feature | ElevenLabs v3 | Gemini Live | Qwen Realtime |
|---------|--------------|-------------|---------------|
| Laughter / giggle | ✅ `[laughs]` tag | ⚠️ possible natively, not documented | ✅ instruction-based |
| Sigh / gasp / gulp | ✅ explicit tags | ❌ not documented | ✅ instruction-based |
| Whisper | ✅ `[whispers]` tag | ✅ "whisper" in prompt | ✅ instruction-based |
| Emotional style tags | ✅ rich (see below) | ⚠️ prompt-only | ✅ instruction-based |
| Thinking sounds / backchanneling | ✅ `[hesitates]` | ⚠️ prompt-only | ✅ **native full-duplex** |
| Affective dialog (adapts to user) | ⚠️ via voice params | ✅ `enable_affective_dialog` | ✅ emotion recognition |
| Paralinguistic sliders | ✅ 5 params | ❌ | ❌ |
| SSML prosody | ❌ (v3 uses tags) | ⚠️ prompt-style only | ❌ |

---

## ElevenLabs (richest)

### Audio tags — the main lever

ElevenLabs v3 Conversational uses square-bracket audio tags embedded in the LLM's text output.
The TTS pipeline renders them as actual audio — the ConvAI orchestrator LLM must be prompted to
emit them, and v3 Conversational honours them without extra config.

**Non-verbal vocalizations:**

```
[laughs]       [chuckles]     [giggles]
[sighs]        [sigh]         [gasps]     [gulps]
[whispers]     [clears throat]
[hesitates]    [stammers]     [pauses]
[short pause]  [long pause]
```

**Emotional delivery tags** (affect the next ~4–5 words then revert):

```
[excited]      [nervous]      [frustrated]   [sorrowful]    [calm]
[cheerfully]   [playfully]    [sarcastically] [dramatically] [deadpan]
[flatly]       [resigned tone] [confident]   [empathetic]   [warm tone]
```

**Character/style tags** (more sustained):

```
[whispers]     [pirate voice]   [British accent]   [French accent]
[evil scientist voice]          [storytelling mode]
```

**Sound effects** (can be used sparingly for effect):

```
[clapping]     [gunshot]       [explosion]
```

**Important:** square brackets only — `*chuckles*`, `<laugh>`, SSML `<say-as>` are not v3 syntax.
v3 also does not support SSML `<prosody>` or `<break>` — use `[slow]`, `[fast]`, `[pauses]`.

### How to get the LLM to emit tags

Tags must appear in the assistant's text output — the ConvAI orchestrator LLM (Gemini 2.5 Flash
by default) needs to be instructed to use them. System prompt section to add:

```
## Expressive delivery
You speak with natural warmth and occasional personality. Use audio cues where appropriate:
- [laughs] or [chuckles] when something is genuinely funny
- [sighs] for moments of mild exasperation or wistfulness  
- [hesitates] before uncertain or sensitive statements
- [excited] when sharing something genuinely interesting
- [warm tone] as your default register in casual exchanges
Do not overuse tags — one or two per response maximum. Never perform emotion that isn't earned.
```

### Paralinguistic sliders

Set in agent config or overridden per-conversation via `conversation_config_override.tts`:

| Parameter | Range | Notes |
|-----------|-------|-------|
| `stability` | 0.0–1.0 | Lower = more dynamic/emotional; higher = consistent but flat |
| `similarity_boost` | 0.0–1.0 | Adherence to training voice |
| `style` | 0.0–1.0 | Exaggerates the voice's natural style; costs compute at high values |
| `use_speaker_boost` | bool | Boosts voice similarity further |
| `speed` | 0.7–1.2 | Speaking rate; 0.9–1.1 recommended for conversation |

**ElevenLabs' "emotional" preset**: stability 0.35, similarity 0.75, style 0.35, speaker_boost on.
Good starting point for a warm, expressive long-session voice.

### Voice model requirement

Audio tags require **Eleven v3 Conversational** as the TTS model in the agent config.
Turbo v2 / Flash v2 use SSML syntax — different, not compatible. Use v3.

### Voice selection

5,000+ voices. For long-session warmth, filter the Voice Library by:
- Category: "Conversational" or "Warm"
- Mood tag: "Friendly", "Warm", "Empathetic"
- Avoid: "Narrative" or "Audiobook" voices — optimised for reading, not dialogue

---

## Gemini Live (most limited, but improving)

### What works

**Affective dialog** (enable via `enable_affective_dialog: true` in session config, requires `v1alpha` API):
- Model detects user's emotional tone from audio and adapts its response style
- Not prescriptive — you can't say "be excited" as an API param, but the model modulates itself

**Natural language style instructions** in system prompt:
```
Speak warmly and conversationally. Use natural pacing with brief pauses.
When something is genuinely interesting, let enthusiasm show in your delivery.
Whisper for emphasis on sensitive points.
```

**Proactivity** (`proactivity: true`): model decides when to respond vs stay silent; filters
background noise and non-directed speech. Useful in a command centre where ambient audio is present.

### What doesn't work (yet)

- No audio tags or SSML in the Live endpoint
- No documented native laughter/gasp generation (the model *may* produce these natively given
  its audio training, but it's not a controllable feature)
- No speaking rate, pitch, or emotion API parameters
- Thinking sounds / filler ("uh-huh", "hmm") not documented as produceable

### Voices (8 available in Live half-cascade models)

| Voice | Character |
|-------|-----------|
| **Puck** | Upbeat, conversational, lively — best for warm long sessions |
| **Fenrir** | Warm, approachable, excitable |
| **Aoede** | Not fully characterised in docs |
| **Charon** | Deep, authoritative |
| **Kore** | Firm, confident, neutral-professional |
| **Leda** | (HD voice, characterisation TBD) |
| **Orus** | (HD voice, characterisation TBD) |
| **Zephyr** | (HD voice, characterisation TBD) |

For long sessions: **Puck** or **Fenrir** first; Charon for a more serious command-centre feel.

### Honest assessment for command-centre UX

Gemini Live is the least expressive of the three for deliberate emotional control. The system
prompt can shape tone but you're relying on the model's judgment, not reliable tags. Best used
when you want Google's reasoning quality and can accept more neutral delivery.

---

## Qwen Realtime (native full-duplex, instruction-based expressiveness)

### Backchanneling — genuine differentiator

Qwen3-Omni natively distinguishes backchanneling ("uh-huh", "hmm", "I see", listener feedback)
from semantic interruptions. In a long conversation, the model responds to these naturally without
treating them as commands. This is **significantly better than ElevenLabs or Gemini** for extended
back-and-forth — it makes the conversation feel genuinely mutual rather than turn-based.

### Expressive vocalizations

The model has been observed producing laughter natively (GitHub reports of "unwanted laughter"
confirm it *can* — the goal is making it controlled rather than surprising). Instruction-based
approach:

```
When something is genuinely amusing, it's natural to chuckle lightly.
Use warm acknowledgements like "mmm" or "ah" to show you're following along.
A gentle sigh is appropriate for moments of empathy or reflection.
Don't suppress natural conversational sounds — they make dialogue feel more human.
```

### Emotion recognition (input → output loop)

Qwen recognises 7 emotions in the user's voice: surprised, neutral, happy, sad, disgusted, angry,
fearful. This feeds into adaptive response tone — the model's output modulates to match or
complement the user's affect. No API param needed; it's always on.

### Speed and expressiveness via instruction

```
speak at a relaxed, unhurried pace — never rushed
speak with warmth and a gentle energy
use natural pauses when considering something
be enthusiastic about ideas without being excitable
```

These are reliable because Qwen's instruction-following for audio style is strong.

### Voice selection

55 voices (47 multilingual + 8 dialect). Known characterised voices:
- **Mia** — current default
- **Tina**, **Cherry**, **Chelsie**, **Serena**, **Ethan**, **Aiden**

Full personality matrix requires DashScope console access or Chinese docs. Worth testing
each candidate voice with a standard paragraph before committing.

---

## Settings UI design

### Structure

```
Settings → Voice Assistant
  ├─ Backend           [picker]
  ├─ Voice             [per-backend picker]
  ├─ Character         [new]
  │    ├─ Preset       [dropdown: Balanced / Warm & Expressive / Calm / Direct / Custom]
  │    └─ Personality notes [textarea — appended to system prompt]
  └─ Voice tuning      [collapsible — ElevenLabs only]
       ├─ Stability          [slider 0–1, default 0.5]
       ├─ Expressiveness     [slider 0–1, default 0.1]
       ├─ Speaking rate      [slider 0.7–1.2, default 1.0]
       ├─ Similarity boost   [slider 0–1, default 0.75]
       └─ [ ] Speaker boost
```

Hide "Voice tuning" entirely for Gemini and Qwen — no grayed-out sliders.

---

### Personality presets

Presets configure the system prompt addition and (for ElevenLabs) the paralinguistic parameters
together. All presets include an audio tags instruction block for ElevenLabs.

#### Balanced (default)

*Warm, focused, professional. Good for task work.*

- ElevenLabs params: stability 0.50, style 0.10, speed 1.0
- Prompt addition: *(none — base VOICE_SYSTEM_PROMPT only)*
- Audio tags guidance: minimal — `[hesitates]`, `[warm tone]` only when natural

#### Warm & Expressive

*Human-feeling, animated. Best for long exploratory sessions.*

- ElevenLabs params: stability 0.35, style 0.30, speed 0.97, speaker_boost on
- Prompt addition:
  ```
  Speak with natural warmth and personality. Use audio cues where they fit:
  [chuckles] or [laughs] when something is genuinely funny,
  [excited] when sharing something interesting,
  [sighs] for wistful or empathetic moments,
  [warm tone] as your default register.
  One or two tags per response maximum — never performed, always earned.
  Speak at a relaxed pace. Pause before considered answers.
  ```

#### Calm

*Measured, reassuring. Good for late-night sessions or complex problem-solving.*

- ElevenLabs params: stability 0.75, style 0.0, speed 0.93
- Prompt addition:
  ```
  Speak slowly and deliberately. [pauses] before important points.
  Use [sighs] and [hesitates] naturally. Never rush.
  Keep energy low and steady.
  ```

#### Direct

*Terse, efficient. Good for rapid task execution.*

- ElevenLabs params: stability 0.65, style 0.05, speed 1.08
- Prompt addition:
  ```
  Be concise. Skip pleasantries unless asked. No filler phrases.
  Short answers. Confirm before elaborating.
  ```

#### Custom

User-defined values. Shows all sliders and a full textarea.

---

### System prompt customisation

The personality notes textarea appends to (never replaces) `VOICE_SYSTEM_PROMPT`.
Character limit: ~500 tokens — enough for a full persona description.

For ElevenLabs, the custom prompt is included in `conversation_config_override.agent.prompt.prompt`
when minting the conversation token (needs hub to fetch the existing agent base prompt and
concatenate — verify ElevenLabs API behaviour before implementing).

For Gemini and Qwen, it's included in system instructions on session start.

---

## Hub changes

### ElevenLabs token endpoint (`POST /voice/token`)

Accept and forward new optional fields:

```typescript
voice_settings?: {
    stability?: number
    similarity_boost?: number
    style?: number
    use_speaker_boost?: boolean
    speed?: number
}
custom_prompt?: string
```

Pass as `conversation_config_override.tts` and `conversation_config_override.agent.prompt.prompt`.

### No hub changes for Gemini / Qwen

Voice and personality params go through the frontend session config and the WebSocket proxy
forwards them as-is in `session.update`.

---

## `VoiceSessionConfig` additions

```typescript
export interface VoiceSessionConfig {
    language?: string
    initialContext?: string
    voiceName?: string          // from voice-selection-all-backends.md
    customPrompt?: string       // personality notes appended to system prompt
    voiceSettings?: {           // ElevenLabs only; ignored by other backends
        stability?: number
        similarityBoost?: number
        style?: number
        useSpeakerBoost?: boolean
        speed?: number
    }
}
```

---

## Implementation notes

### Getting ElevenLabs to emit audio tags reliably

The audio tags instruction must be in the **agent system prompt**, not injected as a contextual
update. Contextual updates are conversational turns, not standing instructions. Include in the
`VOICE_SYSTEM_PROMPT` base or in the `conversation_config_override.agent.prompt.prompt` addition.

### Tag density tuning

One or two tags per response is the right ceiling. More than that tips into performance rather
than natural speech. A useful test: read a response aloud and check whether the tags would feel
genuine if a human said them. If not, the LLM is over-tagging — tighten the prompt instruction.

### Qwen "unwanted laughter" risk

Because Qwen can produce laughter natively and instruction-following is strong, a poorly worded
prompt could make it laugh too readily. Include a qualifier:
```
Natural sounds are appropriate — but only when genuinely fitting. Never perform emotion.
```

### Gemini affective dialog API flag

`enable_affective_dialog: true` is a `v1alpha` API feature — not in the stable endpoint.
Use the alpha API path when enabling it and note it may change. Worth the instability for
long sessions where user mood affects the interaction.

---

## Open questions

1. **ElevenLabs base prompt concatenation** — does `conversation_config_override.agent.prompt.prompt`
   append or replace the agent's configured prompt? Must verify before implementing custom prompt
   pass-through.
2. **Gemini native laughter** — undocumented. Worth a practical test: prompt "laugh warmly when
   something is funny" and try a few amusing inputs. Document the result.
3. **Qwen full voice list** — 55 voices, personalities primarily in Chinese docs. Need a test
   matrix: run a standard warmth-test paragraph through each available voice, note character.
4. **Audio tag prompt engineering** — the right instruction density for tag emission needs
   testing per-voice and per-model. Some ElevenLabs voices interpret tags more naturally than
   others.
5. **Per-session vs persistent personality** — start with persistent (stored settings apply to
   all sessions). Per-session override (different character for different agent sessions) is a
   later enhancement but worth designing the storage shape for.
6. **Qwen backchanneling in HAPI** — Qwen's native full-duplex backchanneling handling means
   the VAD (voice activity detection) threshold may need tuning. The hub's current Qwen proxy
   uses server VAD with `threshold: 0.5, silence_duration_ms: 800`. These values may suppress
   natural "mmm" and "uh-huh" sounds from the user. Worth testing.
