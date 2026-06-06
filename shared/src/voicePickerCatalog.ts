/**
 * Static voice catalogs for Settings picker (Gemini Live, Qwen Realtime).
 * ElevenLabs voices remain dynamic via GET /api/voice/voices (#690).
 *
 * @see https://github.com/tiann/hapi/issues/742
 */

export type VoicePickerOption = {
    id: string
    label: string
    description?: string
}

/** Prebuilt voices documented for Gemini Live BidiGenerateContent. */
export const GEMINI_LIVE_VOICE_OPTIONS: readonly VoicePickerOption[] = [
    { id: 'Puck', label: 'Puck', description: 'Conversational, friendly' },
    { id: 'Charon', label: 'Charon', description: 'Deep, authoritative' },
    { id: 'Kore', label: 'Kore', description: 'Neutral, professional' },
    { id: 'Fenrir', label: 'Fenrir', description: 'Warm, approachable' },
    { id: 'Aoede', label: 'Aoede', description: 'Default' }
] as const

/** English-accessible Qwen Realtime voices (expand after DashScope verification). */
export const QWEN_REALTIME_VOICE_OPTIONS: readonly VoicePickerOption[] = [
    { id: 'Tina', label: 'Tina', description: 'Default' },
    { id: 'Cherry', label: 'Cherry' },
    { id: 'Mia', label: 'Mia' },
    { id: 'Chelsie', label: 'Chelsie' },
    { id: 'Serena', label: 'Serena' },
    { id: 'Ethan', label: 'Ethan' }
] as const

export const VOICE_PICKER_STORAGE_KEYS = {
    elevenlabs: 'hapi-voice-elevenlabs',
    'gemini-live': 'hapi-voice-gemini',
    'qwen-realtime': 'hapi-voice-qwen'
} as const

/** Legacy ElevenLabs key from #690 — read for migration. */
export const LEGACY_ELEVENLABS_VOICE_STORAGE_KEY = 'hapi-voice-id'

/** User-selected voice backend when hub has more than one configured. */
export const VOICE_BACKEND_PREFERENCE_STORAGE_KEY = 'hapi-voice-backend'

export const VOICE_BACKEND_LABELS = {
    elevenlabs: 'ElevenLabs',
    'gemini-live': 'Gemini Live',
    'qwen-realtime': 'Qwen Realtime'
} as const

const geminiVoiceIds = new Set(GEMINI_LIVE_VOICE_OPTIONS.map((v) => v.id))
const qwenVoiceIds = new Set(QWEN_REALTIME_VOICE_OPTIONS.map((v) => v.id))

/** Valid Gemini Live prebuilt voice name, or default (Aoede). */
export function resolveGeminiLiveVoice(voiceName?: string | null): string {
    if (voiceName && geminiVoiceIds.has(voiceName)) {
        return voiceName
    }
    return GEMINI_LIVE_VOICE_OPTIONS.find((v) => v.id === 'Aoede')?.id ?? GEMINI_LIVE_VOICE_OPTIONS[0].id
}

/** Valid Qwen Realtime voice id, or hub default (Tina — matches QWEN_REALTIME_VOICE on qwen3.5-omni-flash-realtime). */
export function resolveQwenRealtimeVoice(voiceName?: string | null): string {
    if (voiceName && qwenVoiceIds.has(voiceName)) {
        return voiceName
    }
    return QWEN_REALTIME_VOICE_OPTIONS.find((v) => v.id === 'Tina')?.id ?? QWEN_REALTIME_VOICE_OPTIONS[0].id
}
