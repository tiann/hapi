import { useCallback, useEffect, useState } from 'react'

export type VoiceMode = 'assistant' | 'dictation-local' | 'dictation-elevenlabs'

const VOICE_MODE_STORAGE_KEY = 'hapi-voice-mode'
const VOICE_MODE_EVENT = 'hapi-voice-mode-change'

function readVoiceMode(): VoiceMode {
    const stored = localStorage.getItem(VOICE_MODE_STORAGE_KEY)
    if (stored === 'dictation' || stored === 'dictation-local') return 'dictation-local'
    if (stored === 'dictation-elevenlabs') return 'dictation-elevenlabs'
    return 'assistant'
}

export function useVoiceMode(): {
    voiceMode: VoiceMode
    setVoiceMode: (mode: VoiceMode) => void
} {
    const [voiceMode, setVoiceModeState] = useState<VoiceMode>(readVoiceMode)

    useEffect(() => {
        const sync = () => setVoiceModeState(readVoiceMode())

        window.addEventListener('storage', sync)
        window.addEventListener(VOICE_MODE_EVENT, sync)
        return () => {
            window.removeEventListener('storage', sync)
            window.removeEventListener(VOICE_MODE_EVENT, sync)
        }
    }, [])

    const setVoiceMode = useCallback((mode: VoiceMode) => {
        localStorage.setItem(VOICE_MODE_STORAGE_KEY, mode)
        setVoiceModeState(mode)
        window.dispatchEvent(new Event(VOICE_MODE_EVENT))
    }, [])

    return {
        voiceMode,
        setVoiceMode
    }
}
