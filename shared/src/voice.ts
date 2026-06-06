/**
 * Shared voice assistant configuration for ElevenLabs ConvAI.
 *
 * This module provides the unified configuration for the Hapi Voice Assistant,
 * ensuring consistency between server-side auto-creation and client-side usage.
 */

import { resolveGeminiLiveVoice, resolveQwenRealtimeVoice } from './voicePickerCatalog'
import {
    VOICE_CHINESE_LANGUAGE_BLOCK,
    composeVoiceAgentPrompt,
    type VoicePromptLayerInput
} from './voicePromptLayers'

export { VOICE_CHINESE_LANGUAGE_BLOCK } from './voicePromptLayers'

export const ELEVENLABS_API_BASE = 'https://api.elevenlabs.io/v1'
export const VOICE_AGENT_NAME = 'Hapi Voice Assistant'

const DEFAULT_COMPOSED_LAYERS: VoicePromptLayerInput = {
    identity: '',
    character: '',
    legacySystemPrompt: '',
    presetDeliverySnippet: ''
}

/** Bundled default composed prompt (fixtures + default identity/character). */
export const VOICE_SYSTEM_PROMPT = composeVoiceAgentPrompt(DEFAULT_COMPOSED_LAYERS)

/** When no language is selected: mirror the user's detected speech language. */
const VOICE_LANGUAGE_BLOCK_AUTO = `

# Language

Detect the language the user is speaking and respond in that same language.
Maintain it consistently throughout the session — do not drift between turns.
If the language cannot be determined, default to English.`

/** BCP-47 code → spoken language name (for explicit-language block). */
const LANGUAGE_NAMES: Record<string, string> = {
    en: 'English',
    es: 'Spanish',
    fr: 'French',
    de: 'German',
    ja: 'Japanese',
    ko: 'Korean',
    pt: 'Portuguese',
    'pt-br': 'Brazilian Portuguese',
    it: 'Italian',
    ar: 'Arabic',
    ru: 'Russian',
    hi: 'Hindi',
    th: 'Thai',
    vi: 'Vietnamese',
    id: 'Indonesian',
    nl: 'Dutch',
    sv: 'Swedish',
    no: 'Norwegian',
    da: 'Danish',
    fi: 'Finnish',
    pl: 'Polish',
    tr: 'Turkish',
    bg: 'Bulgarian',
    ro: 'Romanian',
    cs: 'Czech',
    el: 'Greek',
    ms: 'Malay',
    tl: 'Filipino',
    uk: 'Ukrainian',
    hu: 'Hungarian',
    hr: 'Croatian',
    sk: 'Slovak',
}

/**
 * Returns the language instruction block to append to VOICE_SYSTEM_PROMPT.
 * - Explicit 'zh' → Chinese block
 * - Other explicit code → "Always respond in [Language]"
 * - undefined/auto → "detect from user speech and maintain it"
 */
export function buildVoiceLanguageBlock(language?: string): string {
    if (!language) return VOICE_LANGUAGE_BLOCK_AUTO
    if (language === 'zh' || language.startsWith('zh-')) return VOICE_CHINESE_LANGUAGE_BLOCK
    const name = LANGUAGE_NAMES[language] ?? language
    return `

# Language

IMPORTANT: Always respond in ${name}. Maintain ${name} consistently throughout
the session — do not drift to a different language between turns.
Use English only for proper nouns, code identifiers, and technical terms with
no ${name} equivalent.`
}

/** ElevenLabs first message — language controlled by ElevenLabs language field */
export const VOICE_FIRST_MESSAGE = "Hey! Hapi here — what can I help you with?"

export const VOICE_TOOLS = [
    {
        type: 'client' as const,
        name: 'messageCodingAgent',
        description: 'Send a message to the active coding agent. Use this tool to relay the user\'s coding requests, questions, or instructions to the agent. The message should be clear and complete.',
        expects_response: true,
        response_timeout_secs: 120,
        parameters: {
            type: 'object',
            required: ['message'],
            properties: {
                message: {
                    type: 'string',
                    description: 'The message to send to the coding agent. Should contain the user\'s complete request or instruction.'
                }
            }
        }
    },
    {
        type: 'client' as const,
        name: 'processPermissionRequest',
        description: 'Process a permission request from the coding agent. Use this when the user wants to allow or deny a pending permission request.',
        expects_response: true,
        response_timeout_secs: 30,
        parameters: {
            type: 'object',
            required: ['decision'],
            properties: {
                decision: {
                    type: 'string',
                    description: "The user's decision: must be either 'allow' or 'deny'"
                }
            }
        }
    }
]

export interface VoiceAgentConfig {
    name: string
    conversation_config: {
        agent: {
            first_message: string
            language: string
            prompt: {
                prompt: string
                llm: string
                temperature: number
                max_tokens: number
                tools: typeof VOICE_TOOLS
            }
        }
        turn: {
            turn_timeout: number
            silence_end_call_timeout: number
        }
        tts: {
            voice_id: string
            model_id: string
            speed: number
        }
    }
    platform_settings?: {
        overrides?: {
            conversation_config_override?: {
                agent?: {
                    language?: boolean
                    first_message?: boolean
                    prompt?: {
                        prompt?: boolean
                    }
                }
                tts?: {
                    voice_id?: boolean
                    stability?: boolean
                    similarity_boost?: boolean
                    style?: boolean
                    speed?: boolean
                    use_speaker_boost?: boolean
                }
            }
        }
    }
}

/**
 * Build the agent configuration for Hapi Voice Assistant.
 * Used by both server-side auto-creation and client-side configuration.
 */
export function buildVoiceAgentConfig(): VoiceAgentConfig {
    return {
        name: VOICE_AGENT_NAME,
        conversation_config: {
            agent: {
                first_message: VOICE_FIRST_MESSAGE,
                language: 'en',
                prompt: {
                    prompt: VOICE_SYSTEM_PROMPT,
                    llm: 'gemini-2.5-flash',
                    temperature: 0.7,
                    max_tokens: 1024,
                    tools: VOICE_TOOLS
                }
            },
            turn: {
                turn_timeout: 30.0,
                silence_end_call_timeout: 600.0
            },
            tts: {
                voice_id: 'cgSgspJ2msm6clMCkdW9', // Jessica
                model_id: 'eleven_flash_v2',
                speed: 1.1
            }
        },
        // Enable runtime overrides for language selection
        // See: https://elevenlabs.io/docs/agents-platform/customization/personalization/overrides
        platform_settings: {
            overrides: {
                conversation_config_override: {
                    agent: {
                        language: true,
                        prompt: {
                            prompt: true
                        }
                    },
                    tts: {
                        voice_id: true,
                        stability: true,
                        similarity_boost: true,
                        style: true,
                        speed: true,
                        use_speaker_boost: true
                    }
                }
            }
        }
    }
}

export type VoiceBackendType = 'elevenlabs' | 'gemini-live' | 'qwen-realtime'

export const QWEN_REALTIME_MODEL = 'qwen3.5-omni-flash-realtime'
export const QWEN_REALTIME_VOICE = 'Tina'

export const DEFAULT_VOICE_BACKEND: VoiceBackendType = 'elevenlabs'

const VOICE_BACKEND_VALUES: readonly VoiceBackendType[] = [
    'elevenlabs',
    'gemini-live',
    'qwen-realtime'
] as const

export type VoiceBackendEnv = Record<string, string | undefined>

/** Backends whose API keys are present on the hub. */
export function listConfiguredVoiceBackends(env: VoiceBackendEnv): VoiceBackendType[] {
    const backends: VoiceBackendType[] = []
    if (env.ELEVENLABS_API_KEY?.trim()) {
        backends.push('elevenlabs')
    }
    if (env.GEMINI_API_KEY?.trim() || env.GOOGLE_API_KEY?.trim()) {
        backends.push('gemini-live')
    }
    if (env.DASHSCOPE_API_KEY?.trim() || env.QWEN_API_KEY?.trim()) {
        backends.push('qwen-realtime')
    }
    return backends.length > 0 ? backends : [DEFAULT_VOICE_BACKEND]
}

/** Hub default from VOICE_BACKEND when configured, else first available backend. */
export function resolveHubVoiceBackend(env: VoiceBackendEnv): VoiceBackendType {
    const configured = listConfiguredVoiceBackends(env)
    const raw = env.VOICE_BACKEND
    const fromEnv = VOICE_BACKEND_VALUES.includes(raw as VoiceBackendType)
        ? (raw as VoiceBackendType)
        : DEFAULT_VOICE_BACKEND
    return configured.includes(fromEnv) ? fromEnv : (configured[0] ?? DEFAULT_VOICE_BACKEND)
}

/** User preference wins when valid; otherwise hub default. */
export function resolveEffectiveVoiceBackend(
    configured: readonly VoiceBackendType[],
    hubDefault: VoiceBackendType,
    storedPreference: string | null | undefined
): VoiceBackendType {
    if (
        storedPreference
        && VOICE_BACKEND_VALUES.includes(storedPreference as VoiceBackendType)
        && configured.includes(storedPreference as VoiceBackendType)
    ) {
        return storedPreference as VoiceBackendType
    }
    if (configured.includes(hubDefault)) {
        return hubDefault
    }
    return configured[0] ?? hubDefault
}

export const GEMINI_LIVE_MODEL = 'gemini-2.5-flash-native-audio-latest'
export const GEMINI_LIVE_VOICE = 'Aoede'

export interface VoiceToolDefinition {
    name: string
    description: string
    parameters: {
        type: 'object'
        required: string[]
        properties: Record<string, {
            type: string
            description: string
        }>
    }
}

type VoiceToolSource = Pick<(typeof VOICE_TOOLS)[number], 'name' | 'description' | 'parameters'>

function cloneVoiceToolDefinition(tool: VoiceToolSource): VoiceToolDefinition {
    const properties: VoiceToolDefinition['parameters']['properties'] = {}

    for (const [key, value] of Object.entries(tool.parameters.properties)) {
        properties[key] = {
            type: value.type,
            description: value.description
        }
    }

    return {
        name: tool.name,
        description: tool.description,
        parameters: {
            type: 'object',
            required: [...tool.parameters.required],
            properties
        }
    }
}

export const VOICE_TOOL_DEFINITIONS: VoiceToolDefinition[] = VOICE_TOOLS.map(cloneVoiceToolDefinition)

export type GeminiLiveFunctionDeclaration = VoiceToolDefinition

export interface GeminiLiveConfig {
    model: string
    systemInstruction: string
    tools: Array<{
        functionDeclarations: GeminiLiveFunctionDeclaration[]
    }>
    responseModalities: ['AUDIO']
}

export function buildGeminiLiveFunctionDeclarations(): GeminiLiveFunctionDeclaration[] {
    return VOICE_TOOLS.map(cloneVoiceToolDefinition)
}

export function buildGeminiLiveConfig(
    language?: string,
    voiceName?: string,
    systemInstruction?: string
): GeminiLiveConfig {
    const systemInstructionText = systemInstruction?.trim()
        ? systemInstruction
        : `${VOICE_SYSTEM_PROMPT}${buildVoiceLanguageBlock(language)}`
    return {
        model: GEMINI_LIVE_MODEL,
        systemInstruction: systemInstructionText,
        tools: [
            {
                functionDeclarations: buildGeminiLiveFunctionDeclarations()
            }
        ],
        responseModalities: ['AUDIO']
    }
}

/** Hub-owned initial session.update for Qwen Realtime (hub proxy). */
export function buildQwenSessionUpdateMessage(
    language?: string,
    voiceName?: string,
    systemInstruction?: string
): Record<string, unknown> {
    const instructions = systemInstruction?.trim()
        ? systemInstruction
        : `${VOICE_SYSTEM_PROMPT}${buildVoiceLanguageBlock(language)}`
    // Qwen Realtime uses the flat Realtime shape, not the chat-completions nested {function:{...}} shape.
    const tools = VOICE_TOOL_DEFINITIONS.map((td) => ({
        type: 'function' as const,
        name: td.name,
        description: td.description,
        parameters: td.parameters
    }))
    return {
        type: 'session.update',
        session: {
            modalities: ['text', 'audio'],
            voice: resolveQwenRealtimeVoice(voiceName),
            input_audio_format: 'pcm',
            output_audio_format: 'pcm',
            instructions,
            temperature: 0.7,
            turn_detection: {
                type: 'server_vad',
                threshold: 0.5,
                silence_duration_ms: 800,
                prefix_padding_ms: 300
            },
            tools,
            tool_choice: 'auto'
        }
    }
}

/**
 * Returns true if a client WebSocket frame is safe to forward to DashScope.
 * Blocks session.update frames that touch config fields (tools, voice, etc.);
 * allows instruction-only updates and all runtime event types.
 */
export function isQwenSafeClientFrame(message: string | ArrayBuffer | Uint8Array): boolean {
    try {
        const text = typeof message === 'string'
            ? message
            : new TextDecoder().decode(message instanceof ArrayBuffer ? new Uint8Array(message) : message)
        const parsed = JSON.parse(text) as unknown
        if (!parsed || typeof parsed !== 'object') return true
        const p = parsed as Record<string, unknown>
        if (p.type !== 'session.update') return true
        const session = p.session as Record<string, unknown> | undefined
        if (!session) return false
        const keys = Object.keys(session)
        return keys.length === 1 && keys[0] === 'instructions'
    } catch {
        return true
    }
}

/** Wire-format setup frame for Gemini Live BidiGenerateContent (hub proxy + web client). */
export function buildGeminiLiveSetupMessage(
    language?: string,
    voiceName?: string,
    systemInstruction?: string,
    options?: { affectiveDialog?: boolean }
): { setup: Record<string, unknown> } {
    const liveConfig = buildGeminiLiveConfig(language, voiceName, systemInstruction)
    const resolvedVoice = resolveGeminiLiveVoice(voiceName)
    return {
        setup: {
            model: `models/${liveConfig.model}`,
            generationConfig: {
                responseModalities: ['AUDIO'],
                ...(options?.affectiveDialog ? { enableAffectiveDialog: true } : {}),
                speechConfig: {
                    voiceConfig: {
                        prebuiltVoiceConfig: { voiceName: resolvedVoice }
                    }
                }
            },
            systemInstruction: {
                parts: [{ text: liveConfig.systemInstruction }]
            },
            tools: liveConfig.tools.map((t) => ({
                functionDeclarations: t.functionDeclarations.map((fd) => ({
                    name: fd.name,
                    description: fd.description,
                    parameters: fd.parameters
                }))
            }))
        }
    }
}
