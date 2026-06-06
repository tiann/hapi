import { buildVoiceAgentConfig, VOICE_TOOLS } from '@hapi/protocol/voice'
import {
    DEFAULT_ELEVENLABS_VOICE_SETTINGS,
    ELEVENLABS_WEBRTC_CONTEXT_MAX_BYTES,
    isDefaultVoicePersonality,
    resolveComposedVoiceSystemPrompt,
    resolveElevenLabsVoiceSettings,
    truncateUtf8ByteLength,
    type ElevenLabsVoiceSettings,
    type VoicePersonalityPreferences
} from '@hapi/protocol/voice-personality'
import { loadVoicePersonalityFromStorage } from '@/hooks/useVoicePersonality'

/**
 * ElevenLabs convai rejects sessions whose `overrides` payload references properties
 * the agent has not explicitly authorized (see
 * https://elevenlabs.io/docs/agents-platform/customization/personalization/overrides).
 * The server emits a malformed error packet over the LiveKit data channel, which the
 * convai-react SDK then dereferences as `event.error_type` — undefined → TypeError →
 * disconnect.
 *
 * Defensive rule: emit each top-level override **only** when the user has explicitly
 * diverged from defaults. Empty-prefs sessions must produce exactly `{ agent: { language } }`
 * to match the upstream/main baseline that the convai agent permits today.
 */

function ttsDiffersFromDefault(tts: ElevenLabsVoiceSettings): boolean {
    const d = DEFAULT_ELEVENLABS_VOICE_SETTINGS
    return tts.stability !== d.stability
        || tts.similarity_boost !== d.similarity_boost
        || tts.style !== d.style
        || tts.speed !== d.speed
        || tts.use_speaker_boost !== d.use_speaker_boost
}

function buildElevenLabsTtsOverride(
    tts: ElevenLabsVoiceSettings,
    voiceId?: string
): Record<string, unknown> {
    return {
        stability: tts.stability,
        similarity_boost: tts.similarity_boost,
        style: tts.style,
        speed: tts.speed,
        use_speaker_boost: tts.use_speaker_boost,
        ...(voiceId ? { voice_id: voiceId } : {})
    }
}

function buildElevenLabsAgentPromptOverride(
    prefs: VoicePersonalityPreferences,
    options: { language?: string }
) {
    const base = buildVoiceAgentConfig().conversation_config.agent.prompt
    const composed = resolveComposedVoiceSystemPrompt(prefs, {
        language: options.language,
        backend: 'elevenlabs'
    })
    return {
        prompt: composed.prompt,
        llm: base.llm,
        temperature: base.temperature,
        max_tokens: base.max_tokens,
        tools: VOICE_TOOLS
    }
}

/** Session context for ElevenLabs dynamicVariables only (never embed in prompt override). */
export function capElevenLabsInitialContext(initialContext?: string): string {
    if (!initialContext?.trim()) return ''
    return truncateUtf8ByteLength(initialContext, ELEVENLABS_WEBRTC_CONTEXT_MAX_BYTES)
}

export interface ElevenLabsSessionOverrides {
    agent?: {
        language?: string
        prompt?: ReturnType<typeof buildElevenLabsAgentPromptOverride>
    }
    tts?: Record<string, unknown>
}

export function buildElevenLabsSessionOverridesFromPrefs(
    prefs: VoicePersonalityPreferences,
    config: {
        language?: string
        voiceId?: string
    }
): ElevenLabsSessionOverrides {
    const overrides: ElevenLabsSessionOverrides = {}

    const tts = resolveElevenLabsVoiceSettings(prefs)
    const customTts = ttsDiffersFromDefault(tts)
    if (customTts) {
        overrides.tts = buildElevenLabsTtsOverride(tts, config.voiceId)
    } else if (config.voiceId) {
        overrides.tts = { voice_id: config.voiceId }
    }

    const agent: NonNullable<ElevenLabsSessionOverrides['agent']> = {}
    if (config.language) {
        agent.language = config.language
    }
    if (!isDefaultVoicePersonality(prefs)) {
        agent.prompt = buildElevenLabsAgentPromptOverride(prefs, {
            language: config.language
        })
    }
    if (Object.keys(agent).length > 0) {
        overrides.agent = agent
    }

    return overrides
}

export function buildElevenLabsSessionOverrides(config: {
    language?: string
    voiceId?: string
}) {
    return buildElevenLabsSessionOverridesFromPrefs(loadVoicePersonalityFromStorage(), config)
}

/** Base64url for Gemini hub proxy (?systemPrompt=). */
export function encodeVoiceSystemPromptForProxy(prompt: string): string {
    const bytes = new TextEncoder().encode(prompt)
    let binary = ''
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]!)
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// base64url: 3 raw bytes → 4 encoded chars, so 12 000 encoded chars ≈ 9 000 raw bytes.
const PROXY_PROMPT_MAX_RAW_BYTES = Math.floor(12_000 * 3 / 4)

/**
 * Truncate a string so that its UTF-8 byte length does not exceed the proxy
 * query-param cap. Truncates on a byte boundary (safe for multi-byte chars).
 */
export function truncatePromptForProxy(prompt: string): string {
    const bytes = new TextEncoder().encode(prompt)
    if (bytes.length <= PROXY_PROMPT_MAX_RAW_BYTES) return prompt
    return new TextDecoder().decode(bytes.slice(0, PROXY_PROMPT_MAX_RAW_BYTES))
}

export function buildResolvedVoiceSystemPrompt(options?: {
    language?: string
    backend?: 'elevenlabs' | 'gemini-live' | 'qwen-realtime'
}): string {
    const personality = loadVoicePersonalityFromStorage()
    return resolveComposedVoiceSystemPrompt(personality, {
        language: options?.language,
        backend: options?.backend ?? 'gemini-live'
    }).prompt
}
