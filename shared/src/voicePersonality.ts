/**
 * Voice personality / delivery controls shared by Settings UI and realtime sessions.
 * @see docs/plans/voice-personality-config.md
 */

import { VOICE_SYSTEM_PROMPT, buildVoiceLanguageBlock } from './voice'
import {
    composeVoiceAgentPrompt,
    getVoicePlatformFixturesPreview,
    type VoicePromptLayerInput
} from './voicePromptLayers'

export type VoicePersonalityPresetId =
    | 'balanced'
    | 'warm'
    | 'calm'
    | 'direct'
    | 'custom'

export type VoiceBackendKind = 'elevenlabs' | 'gemini-live' | 'qwen-realtime'

/** ElevenLabs ConvAI runtime TTS overrides (snake_case for API). */
export interface ElevenLabsVoiceSettings {
    stability: number
    similarity_boost: number
    style: number
    speed: number
    use_speaker_boost: boolean
}

export interface GeminiVoiceOptions {
    affective_dialog: boolean
}

export type ResponseLengthOption = 'brief' | 'balanced' | 'detailed'

export const RESPONSE_LENGTH_OPTIONS: readonly ResponseLengthOption[] = ['brief', 'balanced', 'detailed']

const RESPONSE_LENGTH_INSTRUCTIONS: Record<ResponseLengthOption, string> = {
    brief: '\n\n# Response length\n\nKeep all voice responses to 1–2 sentences. Be concise and direct.',
    balanced: '',
    detailed: '\n\n# Response length\n\nGive thorough responses when the topic warrants depth. Do not truncate if completeness is needed.',
}

export function getResponseLengthInstruction(length: ResponseLengthOption): string {
    return RESPONSE_LENGTH_INSTRUCTIONS[length]
}

export interface VoicePersonalityPreferences {
    preset: VoicePersonalityPresetId
    /** Who the assistant is (rebrand / overseer). Empty = bundled default identity. */
    identity: string
    /** Delivery, tone, preset overlays. Empty = default character + preset snippet. */
    character: string
    /**
     * @deprecated Migrated to identity/character on parse. Full monolith kept only when it
     * still contains platform fixtures (legacy override).
     */
    systemPrompt: string
    /** @deprecated Migrated into character on parse. */
    customPrompt: string
    /** How long responses should be. 'balanced' is the default (no extra instruction). */
    responseLength: ResponseLengthOption
    elevenLabs: ElevenLabsVoiceSettings
    gemini: GeminiVoiceOptions
}

export const VOICE_IDENTITY_MAX_LENGTH = 8_000
export const VOICE_CHARACTER_MAX_LENGTH = 16_000

/** Max stored prompt size (localStorage + Gemini WS query param budget). */
export const VOICE_SYSTEM_PROMPT_MAX_LENGTH = 48_000

/** ElevenLabs ConvAI WebRTC data channel limit per message (bytes). */
export const ELEVENLABS_WEBRTC_MAX_MESSAGE_BYTES = 65_535

/** Budget for session bootstrap in startSession dynamicVariables. */
export const ELEVENLABS_WEBRTC_CONTEXT_MAX_BYTES = 4_000

/** Budget per deferred context chunk (streamed after connect). */
export const VOICE_CONTEXT_STREAM_CHUNK_MAX_BYTES = 8_000

/** Budget for composed system prompt in agent overrides (+ tools JSON uses the rest). */
export const ELEVENLABS_WEBRTC_PROMPT_MAX_BYTES = 12_000

/** Trim UTF-8 text to a byte budget (for WebRTC / query-param limits). */
export function truncateUtf8ByteLength(text: string, maxBytes: number): string {
    if (maxBytes <= 0) return ''
    const encoder = new TextEncoder()
    if (encoder.encode(text).length <= maxBytes) return text

    const suffix = '\n\n[…truncated for voice transport…]'
    const suffixBytes = encoder.encode(suffix).length
    const budget = Math.max(0, maxBytes - suffixBytes)

    let lo = 0
    let hi = text.length
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2)
        if (encoder.encode(text.slice(0, mid)).length <= budget) lo = mid
        else hi = mid - 1
    }
    return text.slice(0, lo) + suffix
}

export function utf8ByteLength(text: string): number {
    return new TextEncoder().encode(text).length
}

export const VOICE_PERSONALITY_STORAGE_KEY = 'hapi-voice-personality'
export const VOICE_CONTEXT_NOTICE_STORAGE_KEY = 'hapi-voice-context-notice'

export const DEFAULT_ELEVENLABS_VOICE_SETTINGS: ElevenLabsVoiceSettings = {
    stability: 0.5,
    similarity_boost: 0.75,
    style: 0.1,
    speed: 1.0,
    use_speaker_boost: false
}

export const DEFAULT_GEMINI_VOICE_OPTIONS: GeminiVoiceOptions = {
    affective_dialog: true
}

export const DEFAULT_VOICE_PERSONALITY: VoicePersonalityPreferences = {
    preset: 'balanced',
    identity: '',
    character: '',
    systemPrompt: '',
    customPrompt: '',
    responseLength: 'balanced',
    elevenLabs: { ...DEFAULT_ELEVENLABS_VOICE_SETTINGS },
    gemini: { ...DEFAULT_GEMINI_VOICE_OPTIONS }
}

export function voicePromptLayersFromPrefs(prefs: VoicePersonalityPreferences): VoicePromptLayerInput {
    return {
        identity: prefs.identity,
        character: prefs.character,
        legacySystemPrompt: prefs.systemPrompt,
        presetDeliverySnippet: getPresetDeliverySnippet(prefs.preset)
    }
}

/** Bundled composed prompt for the session language (editable copy baseline in Settings). */
export function getDefaultVoiceSystemPrompt(language?: string): string {
    return composeVoiceAgentPrompt(voicePromptLayersFromPrefs(DEFAULT_VOICE_PERSONALITY))
        + (language ? buildVoiceLanguageBlock(language) : '')
}

export interface VoicePromptComposeResult {
    prompt: string
    truncated: boolean
    wireBytes: number
}

/** Effective composed system prompt for a voice session (all backends). Session context is never embedded here. */
export function resolveComposedVoiceSystemPrompt(
    prefs: VoicePersonalityPreferences,
    options?: {
        language?: string
        backend?: VoiceBackendKind
        maxWireBytes?: number
    }
): VoicePromptComposeResult {
    const lang = options?.language
    const isElevenLabs = options?.backend === 'elevenlabs'
    // ElevenLabs has its own language field; Gemini/Qwen need the block in the prompt.
    // For Gemini/Qwen, always include it: undefined → auto-detect block, code → explicit block.
    let prompt = composeVoiceAgentPrompt(voicePromptLayersFromPrefs(prefs))
        + (isElevenLabs ? (lang ? buildVoiceLanguageBlock(lang) : '') : buildVoiceLanguageBlock(lang))
    prompt += getResponseLengthInstruction(prefs.responseLength ?? 'balanced')

    const maxBytes = options?.maxWireBytes
        ?? (options?.backend === 'elevenlabs' ? ELEVENLABS_WEBRTC_PROMPT_MAX_BYTES : undefined)

    let truncated = false
    if (maxBytes && utf8ByteLength(prompt) > maxBytes) {
        prompt = truncateUtf8ByteLength(prompt, maxBytes)
        truncated = true
    }

    return { prompt, truncated, wireBytes: utf8ByteLength(prompt) }
}

/** @deprecated Use resolveComposedVoiceSystemPrompt().prompt */
export function resolveVoiceSystemPrompt(
    prefs: VoicePersonalityPreferences,
    options?: { language?: string; initialContext?: string }
): string {
    void options?.initialContext
    return resolveComposedVoiceSystemPrompt(prefs, { language: options?.language }).prompt
}

export function isDefaultVoicePersonality(prefs: VoicePersonalityPreferences): boolean {
    return (prefs.preset ?? 'balanced') === 'balanced'
        && !prefs.identity.trim()
        && !prefs.character.trim()
        && !prefs.systemPrompt.trim()
        && (prefs.responseLength ?? 'balanced') === 'balanced'
}

/** @deprecated Use isDefaultVoicePersonality */
export function isDefaultVoiceSystemPrompt(prefs: VoicePersonalityPreferences, _language?: string): boolean {
    return isDefaultVoicePersonality(prefs)
}

export {
    DEFAULT_VOICE_CHARACTER,
    DEFAULT_VOICE_IDENTITY,
    getVoicePlatformFixturesPreview
} from './voicePromptLayers'

export interface VoicePersonalityPresetDefinition {
    id: VoicePersonalityPresetId
    labelKey: string
    descriptionKey: string
    promptAddition: string
    elevenLabs: ElevenLabsVoiceSettings
}

export const VOICE_PERSONALITY_PRESETS: readonly VoicePersonalityPresetDefinition[] = [
    {
        id: 'balanced',
        labelKey: 'settings.voice.character.preset.balanced',
        descriptionKey: 'settings.voice.character.preset.balancedHint',
        promptAddition: '',
        elevenLabs: {
            stability: 0.5,
            similarity_boost: 0.75,
            style: 0.1,
            speed: 1.0,
            use_speaker_boost: false
        }
    },
    {
        id: 'warm',
        labelKey: 'settings.voice.character.preset.warm',
        descriptionKey: 'settings.voice.character.preset.warmHint',
        promptAddition: `Speak with natural warmth and personality. Use audio cues where they fit:
[chuckles] or [laughs] when something is genuinely funny,
[excited] when sharing something interesting,
[sighs] for wistful or empathetic moments,
[warm tone] as your default register.
One or two tags per response maximum — never performed, always earned.
Speak at a relaxed pace. Pause before considered answers.`,
        elevenLabs: {
            stability: 0.35,
            similarity_boost: 0.75,
            style: 0.3,
            speed: 0.97,
            use_speaker_boost: true
        }
    },
    {
        id: 'calm',
        labelKey: 'settings.voice.character.preset.calm',
        descriptionKey: 'settings.voice.character.preset.calmHint',
        promptAddition: `Speak slowly and deliberately. [pauses] before important points.
Use [sighs] and [hesitates] naturally. Never rush.
Keep energy low and steady.`,
        elevenLabs: {
            stability: 0.75,
            similarity_boost: 0.75,
            style: 0.0,
            speed: 0.93,
            use_speaker_boost: false
        }
    },
    {
        id: 'direct',
        labelKey: 'settings.voice.character.preset.direct',
        descriptionKey: 'settings.voice.character.preset.directHint',
        promptAddition: `Be concise. Skip pleasantries unless asked. No filler phrases.
Short answers. Confirm before elaborating.`,
        elevenLabs: {
            stability: 0.65,
            similarity_boost: 0.75,
            style: 0.05,
            speed: 1.08,
            use_speaker_boost: false
        }
    },
    {
        id: 'custom',
        labelKey: 'settings.voice.character.preset.custom',
        descriptionKey: 'settings.voice.character.preset.customHint',
        promptAddition: '',
        elevenLabs: { ...DEFAULT_ELEVENLABS_VOICE_SETTINGS }
    }
] as const

export function getVoicePersonalityPreset(
    id: VoicePersonalityPresetId
): VoicePersonalityPresetDefinition {
    return VOICE_PERSONALITY_PRESETS.find((p) => p.id === id) ?? VOICE_PERSONALITY_PRESETS[0]
}

export function clamp01(value: number): number {
    if (Number.isNaN(value)) return 0
    return Math.min(1, Math.max(0, value))
}

export function clampSpeed(value: number): number {
    if (Number.isNaN(value)) return 1
    return Math.min(1.2, Math.max(0.7, value))
}

function isBundledMonolith(systemPrompt: string): boolean {
    const trimmed = systemPrompt.trim()
    if (!trimmed) return false
    return trimmed === VOICE_SYSTEM_PROMPT || trimmed.startsWith('# CRITICAL RULE')
}

export function parseVoicePersonalityPreferences(raw: unknown): VoicePersonalityPreferences {
    if (!raw || typeof raw !== 'object') {
        return structuredClone(DEFAULT_VOICE_PERSONALITY)
    }
    const record = raw as Record<string, unknown>
    const presetRaw = record.preset
    const preset = VOICE_PERSONALITY_PRESETS.some((p) => p.id === presetRaw)
        ? (presetRaw as VoicePersonalityPresetId)
        : 'balanced'

    const elRaw = record.elevenLabs
    const el = elRaw && typeof elRaw === 'object'
        ? (elRaw as Record<string, unknown>)
        : {}

    const geminiRaw = record.gemini
    const gemini = geminiRaw && typeof geminiRaw === 'object'
        ? (geminiRaw as Record<string, unknown>)
        : {}

    let identity = typeof record.identity === 'string' ? record.identity : ''
    let character = typeof record.character === 'string' ? record.character : ''
    let systemPrompt = typeof record.systemPrompt === 'string' ? record.systemPrompt : ''

    const legacyNotes = typeof record.customPrompt === 'string' ? record.customPrompt.trim() : ''
    if (legacyNotes && !character.trim()) {
        character = legacyNotes
    }

    if (!identity.trim() && !character.trim() && systemPrompt.trim()) {
        if (isBundledMonolith(systemPrompt)) {
            systemPrompt = ''
        } else if (systemPrompt.includes('# CRITICAL RULE')) {
            // Legacy full override — keep in systemPrompt for composeVoiceAgentPrompt
        } else {
            character = systemPrompt
            systemPrompt = ''
        }
    }

    const responseLengthRaw = record.responseLength
    const responseLength: ResponseLengthOption = RESPONSE_LENGTH_OPTIONS.includes(responseLengthRaw as ResponseLengthOption)
        ? (responseLengthRaw as ResponseLengthOption)
        : 'balanced'

    return {
        preset,
        identity: identity.slice(0, VOICE_IDENTITY_MAX_LENGTH),
        character: character.slice(0, VOICE_CHARACTER_MAX_LENGTH),
        systemPrompt: systemPrompt.slice(0, VOICE_SYSTEM_PROMPT_MAX_LENGTH),
        customPrompt: '',
        responseLength,
        elevenLabs: {
            stability: clamp01(Number(el.stability ?? DEFAULT_ELEVENLABS_VOICE_SETTINGS.stability)),
            similarity_boost: clamp01(Number(el.similarity_boost ?? el.similarityBoost ?? DEFAULT_ELEVENLABS_VOICE_SETTINGS.similarity_boost)),
            style: clamp01(Number(el.style ?? DEFAULT_ELEVENLABS_VOICE_SETTINGS.style)),
            speed: clampSpeed(Number(el.speed ?? DEFAULT_ELEVENLABS_VOICE_SETTINGS.speed)),
            use_speaker_boost: Boolean(el.use_speaker_boost ?? el.useSpeakerBoost ?? DEFAULT_ELEVENLABS_VOICE_SETTINGS.use_speaker_boost)
        },
        gemini: {
            affective_dialog: gemini.affective_dialog !== false && gemini.affectiveDialog !== false
        }
    }
}

/** Optional delivery snippet from the selected preset (merged into character layer when character empty). */
export function getPresetDeliverySnippet(presetId: VoicePersonalityPresetId): string {
    return getVoicePersonalityPreset(presetId).promptAddition.trim()
}

/**
 * @deprecated Use resolveComposedVoiceSystemPrompt. Preset text is merged in the character layer.
 */
export function buildVoicePersonalityPromptAddition(prefs: VoicePersonalityPreferences): string {
    return getPresetDeliverySnippet(prefs.preset)
}

/** Effective ElevenLabs sliders — custom preset uses stored values; others use preset defaults unless preset is custom. */
export function resolveElevenLabsVoiceSettings(prefs: VoicePersonalityPreferences): ElevenLabsVoiceSettings {
    if (prefs.preset === 'custom') {
        return { ...prefs.elevenLabs }
    }
    return { ...getVoicePersonalityPreset(prefs.preset).elevenLabs }
}

export type VoiceControlLeverId =
    | 'character_preset'
    | 'voice_identity'
    | 'voice_character'
    | 'voice_fixtures'
    | 'speaking_rate'
    | 'expressiveness'
    | 'stability'
    | 'similarity_boost'
    | 'speaker_boost'
    | 'affective_dialog'

export interface VoiceControlLever {
    id: VoiceControlLeverId
    backends: VoiceBackendKind[]
}

/** Levers exposed in Settings → Advanced voice (common vs backend-specific). */
export const VOICE_CONTROL_LEVERS: readonly VoiceControlLever[] = [
    { id: 'character_preset', backends: ['elevenlabs', 'gemini-live', 'qwen-realtime'] },
    { id: 'voice_identity', backends: ['elevenlabs', 'gemini-live', 'qwen-realtime'] },
    { id: 'voice_character', backends: ['elevenlabs', 'gemini-live', 'qwen-realtime'] },
    { id: 'voice_fixtures', backends: ['elevenlabs', 'gemini-live', 'qwen-realtime'] },
    { id: 'speaking_rate', backends: ['elevenlabs', 'gemini-live', 'qwen-realtime'] },
    { id: 'expressiveness', backends: ['elevenlabs', 'gemini-live', 'qwen-realtime'] },
    { id: 'stability', backends: ['elevenlabs'] },
    { id: 'similarity_boost', backends: ['elevenlabs'] },
    { id: 'speaker_boost', backends: ['elevenlabs'] },
    { id: 'affective_dialog', backends: ['gemini-live'] }
]

export function leverAppliesToBackend(lever: VoiceControlLever, backend: VoiceBackendKind): boolean {
    return lever.backends.includes(backend)
}

export function getVoiceWireBudgetHint(backend: VoiceBackendKind): {
    storageMaxChars: number
    wireNoteKey: string
} {
    switch (backend) {
        case 'elevenlabs':
            return {
                storageMaxChars: VOICE_SYSTEM_PROMPT_MAX_LENGTH,
                wireNoteKey: 'settings.voice.wireBudget.elevenlabs'
            }
        case 'gemini-live':
            return {
                storageMaxChars: VOICE_SYSTEM_PROMPT_MAX_LENGTH,
                wireNoteKey: 'settings.voice.wireBudget.gemini'
            }
        case 'qwen-realtime':
            return {
                storageMaxChars: VOICE_SYSTEM_PROMPT_MAX_LENGTH,
                wireNoteKey: 'settings.voice.wireBudget.qwen'
            }
    }
}
