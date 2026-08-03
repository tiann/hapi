import { useCallback, useEffect, useState } from 'react'
import type { ApiClient } from '@/api/client'
import {
    BROWSER_LOCAL_TRANSCRIPTION_PROVIDER,
    type TranscriptionMode,
    type TranscriptionProvider,
    type TranscriptionProviderInfo,
    type VoiceMode
} from '@hapi/protocol/voice'

const VOICE_MODE_KEY = 'hapi-voice-mode'
const TRANSCRIPTION_PROVIDER_KEY = 'hapi-transcription-provider'
const TRANSCRIPTION_MODE_KEY = 'hapi-transcription-mode'
const CHANGE_EVENT = 'hapi-voice-input-change'
export const VOICE_LANGUAGE_CHANGE_EVENT = 'hapi-voice-language-change'

function notifyChange(): void {
    window.dispatchEvent(new Event(CHANGE_EVENT))
}

async function browserLocalTranscriptionSupported(): Promise<boolean> {
    const constructor = (globalThis as typeof globalThis & {
        SpeechRecognition?: {
            prototype: object
            available?: (options: { langs: string[]; processLocally: true }) => Promise<string>
        }
    }).SpeechRecognition
    if (!constructor || typeof constructor.available !== 'function' || !('processLocally' in constructor.prototype)) return false
    const language = localStorage.getItem('hapi-voice-lang') || navigator.language
    try {
        return await constructor.available({ langs: [language], processLocally: true }) === 'available'
    } catch {
        return false
    }
}

function readVoiceMode(): VoiceMode {
    return localStorage.getItem(VOICE_MODE_KEY) === 'dictation' ? 'dictation' : 'assistant'
}

function resolveProvider(
    providers: readonly TranscriptionProviderInfo[],
    stored: string | null
): TranscriptionProvider | null {
    return providers.find((provider) => provider.id === stored)?.id ?? providers[0]?.id ?? null
}

function resolveMode(
    providers: readonly TranscriptionProviderInfo[],
    provider: TranscriptionProvider | null,
    stored: string | null
): TranscriptionMode {
    const modes = providers.find((candidate) => candidate.id === provider)?.modes ?? ['standard']
    if ((stored === 'standard' || stored === 'realtime') && modes.includes(stored)) return stored
    return modes[0] ?? 'standard'
}

export function useVoiceInputPreferences(api: ApiClient | null) {
    const [voiceMode, setVoiceModeState] = useState<VoiceMode>(readVoiceMode)
    const [providers, setProviders] = useState<TranscriptionProviderInfo[]>([])
    const [provider, setProviderState] = useState<TranscriptionProvider | null>(null)
    const [transcriptionMode, setTranscriptionModeState] = useState<TranscriptionMode>('standard')

    useEffect(() => {
        if (!api) return
        let cancelled = false
        let request = 0
        const refreshProviders = () => {
            const current = ++request
            Promise.all([api.fetchTranscriptionProviders(), browserLocalTranscriptionSupported()]).then(([{ providers: configured }, browserLocal]) => {
                if (cancelled || current !== request) return
                const available = browserLocal
                    ? [...configured, BROWSER_LOCAL_TRANSCRIPTION_PROVIDER]
                    : configured
                setProviders(available)
                const selectedProvider = resolveProvider(available, localStorage.getItem(TRANSCRIPTION_PROVIDER_KEY))
                setProviderState(selectedProvider)
                setTranscriptionModeState(resolveMode(available, selectedProvider, localStorage.getItem(TRANSCRIPTION_MODE_KEY)))
            }).catch(() => {
                if (!cancelled && current === request) setProviders([])
            })
        }
        refreshProviders()
        window.addEventListener(VOICE_LANGUAGE_CHANGE_EVENT, refreshProviders)
        return () => {
            cancelled = true
            window.removeEventListener(VOICE_LANGUAGE_CHANGE_EVENT, refreshProviders)
        }
    }, [api])

    useEffect(() => {
        const sync = () => {
            setVoiceModeState(readVoiceMode())
            const selectedProvider = resolveProvider(providers, localStorage.getItem(TRANSCRIPTION_PROVIDER_KEY))
            setProviderState(selectedProvider)
            setTranscriptionModeState(resolveMode(providers, selectedProvider, localStorage.getItem(TRANSCRIPTION_MODE_KEY)))
        }
        window.addEventListener('storage', sync)
        window.addEventListener(CHANGE_EVENT, sync)
        return () => {
            window.removeEventListener('storage', sync)
            window.removeEventListener(CHANGE_EVENT, sync)
        }
    }, [providers])

    const setVoiceMode = useCallback((value: VoiceMode) => {
        localStorage.setItem(VOICE_MODE_KEY, value)
        setVoiceModeState(value)
        notifyChange()
    }, [])

    const setProvider = useCallback((value: TranscriptionProvider) => {
        const nextMode = resolveMode(providers, value, localStorage.getItem(TRANSCRIPTION_MODE_KEY))
        localStorage.setItem(TRANSCRIPTION_PROVIDER_KEY, value)
        localStorage.setItem(TRANSCRIPTION_MODE_KEY, nextMode)
        setProviderState(value)
        setTranscriptionModeState(nextMode)
        notifyChange()
    }, [providers])

    const setTranscriptionMode = useCallback((value: TranscriptionMode) => {
        const nextMode = resolveMode(providers, provider, value)
        localStorage.setItem(TRANSCRIPTION_MODE_KEY, nextMode)
        setTranscriptionModeState(nextMode)
        notifyChange()
    }, [provider, providers])

    return {
        voiceMode,
        setVoiceMode,
        providers,
        provider,
        setProvider,
        transcriptionMode,
        setTranscriptionMode,
        modes: providers.find((candidate) => candidate.id === provider)?.modes ?? ['standard']
    }
}
