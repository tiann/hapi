import { useCallback, useEffect, useState } from 'react'
import type { ApiClient } from '@/api/client'
import {
    BROWSER_LOCAL_TRANSCRIPTION_PROVIDER,
    type TranscriptionMode,
    type TranscriptionProvider,
    type TranscriptionProviderInfo,
    type VoiceMode
} from '@hapi/protocol/voice'
import { hasBrowserLocalSpeechSupport } from './browserLocalSpeech'

const VOICE_MODE_KEY = 'hapi-voice-mode'
const TRANSCRIPTION_PROVIDER_KEY = 'hapi-transcription-provider'
const TRANSCRIPTION_MODE_KEY = 'hapi-transcription-mode'
const CHANGE_EVENT = 'hapi-voice-input-change'

function notifyChange(): void {
    window.dispatchEvent(new Event(CHANGE_EVENT))
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
        const browserLocal = hasBrowserLocalSpeechSupport()
        const load = () => {
            api.fetchTranscriptionProviders().then(({ providers: configured }) => {
                if (cancelled) return
                const available = browserLocal
                    ? [...configured, BROWSER_LOCAL_TRANSCRIPTION_PROVIDER]
                    : configured
                setProviders(available)
                const selectedProvider = resolveProvider(available, localStorage.getItem(TRANSCRIPTION_PROVIDER_KEY))
                setProviderState(selectedProvider)
                setTranscriptionModeState(resolveMode(available, selectedProvider, localStorage.getItem(TRANSCRIPTION_MODE_KEY)))
            }).catch(() => {
                if (!cancelled) setProviders([])
            })
        }
        load()
        const onRefresh = () => load()
        window.addEventListener('hapi-transcription-providers-refresh', onRefresh)
        return () => {
            cancelled = true
            window.removeEventListener('hapi-transcription-providers-refresh', onRefresh)
        }
    }, [api])

    const refreshProviders = useCallback(() => {
        window.dispatchEvent(new Event('hapi-transcription-providers-refresh'))
    }, [])

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
        refreshProviders,
        modes: providers.find((candidate) => candidate.id === provider)?.modes ?? ['standard']
    }
}
