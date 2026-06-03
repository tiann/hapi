import {
    resolveEffectiveVoiceBackend,
    type VoiceBackendType
} from '@hapi/protocol/voice'
import {
    GEMINI_LIVE_VOICE_OPTIONS,
    LEGACY_ELEVENLABS_VOICE_STORAGE_KEY,
    QWEN_REALTIME_VOICE_OPTIONS,
    VOICE_BACKEND_PREFERENCE_STORAGE_KEY,
    VOICE_PICKER_STORAGE_KEYS,
    type VoicePickerOption
} from '@hapi/protocol/voicePickerCatalog'

export function migrateLegacyElevenLabsVoiceId(): void {
    const legacy = localStorage.getItem(LEGACY_ELEVENLABS_VOICE_STORAGE_KEY)
    if (!legacy) {
        return
    }
    if (!localStorage.getItem(VOICE_PICKER_STORAGE_KEYS.elevenlabs)) {
        localStorage.setItem(VOICE_PICKER_STORAGE_KEYS.elevenlabs, legacy)
    }
    localStorage.removeItem(LEGACY_ELEVENLABS_VOICE_STORAGE_KEY)
}

export function getVoiceStorageKey(backend: VoiceBackendType): string {
    if (backend === 'gemini-live') {
        return VOICE_PICKER_STORAGE_KEYS['gemini-live']
    }
    if (backend === 'qwen-realtime') {
        return VOICE_PICKER_STORAGE_KEYS['qwen-realtime']
    }
    return VOICE_PICKER_STORAGE_KEYS.elevenlabs
}

export function readStoredVoiceSelection(backend: VoiceBackendType): string | null {
    if (backend === 'elevenlabs') {
        migrateLegacyElevenLabsVoiceId()
    }
    return localStorage.getItem(getVoiceStorageKey(backend))
}

export function writeStoredVoiceSelection(backend: VoiceBackendType, id: string | null): void {
    const key = getVoiceStorageKey(backend)
    if (id === null) {
        localStorage.removeItem(key)
    } else {
        localStorage.setItem(key, id)
    }
}

export function readStoredVoiceBackendPreference(): string | null {
    return localStorage.getItem(VOICE_BACKEND_PREFERENCE_STORAGE_KEY)
}

export function writeStoredVoiceBackendPreference(backend: VoiceBackendType): void {
    localStorage.setItem(VOICE_BACKEND_PREFERENCE_STORAGE_KEY, backend)
}

export function resolveSelectedVoiceBackend(
    configured: readonly VoiceBackendType[],
    hubDefault: VoiceBackendType
): VoiceBackendType {
    return resolveEffectiveVoiceBackend(
        configured,
        hubDefault,
        readStoredVoiceBackendPreference()
    )
}

export function getStaticVoiceOptions(backend: VoiceBackendType): readonly VoicePickerOption[] {
    if (backend === 'gemini-live') {
        return GEMINI_LIVE_VOICE_OPTIONS
    }
    if (backend === 'qwen-realtime') {
        return QWEN_REALTIME_VOICE_OPTIONS
    }
    return []
}
