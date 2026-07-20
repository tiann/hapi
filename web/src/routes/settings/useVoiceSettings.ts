import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppContext } from '@/lib/app-context'
import { useTranslation } from '@/lib/use-translation'
import { fetchVoiceBackend, fetchVoices, type VoiceInfo } from '@/api/voice'
import { getFallbackVoices } from '@/lib/voices'
import { getElevenLabsSupportedLanguages, type Language } from '@/lib/languages'
import {
    getStaticVoiceOptions,
    readStoredVoiceSelection,
    resolveSelectedVoiceBackend,
    writeStoredVoiceBackendPreference,
    writeStoredVoiceSelection,
} from '@/lib/voicePickerPreferences'
import type { VoiceBackendType } from '@hapi/protocol/voice'

export function useVoiceSettings() {
    const { api } = useAppContext()
    const { locale } = useTranslation()
    const [configuredBackends, setConfiguredBackends] = useState<VoiceBackendType[]>([])
    const [backend, setBackendState] = useState<VoiceBackendType | null>(null)
    const [voiceId, setVoiceIdState] = useState<string | null>(null)
    const [dynamicVoices, setDynamicVoices] = useState<VoiceInfo[] | null>(null)
    const [voiceLanguage, setVoiceLanguageState] = useState<string | null>(() => localStorage.getItem('hapi-voice-lang'))
    const [playingVoiceId, setPlayingVoiceId] = useState<string | null>(null)
    const audioRef = useRef<HTMLAudioElement | null>(null)

    useEffect(() => {
        let cancelled = false
        fetchVoiceBackend(api).then((response) => {
            if (cancelled) return
            setConfiguredBackends(response.backends)
            const selected = resolveSelectedVoiceBackend(response.backends, response.backend)
            setBackendState(selected)
            setVoiceIdState(readStoredVoiceSelection(selected))
        }).catch(() => {
            if (cancelled) return
            setConfiguredBackends(['elevenlabs'])
            setBackendState('elevenlabs')
            setVoiceIdState(readStoredVoiceSelection('elevenlabs'))
        })
        return () => { cancelled = true }
    }, [api])

    useEffect(() => {
        if (backend !== 'elevenlabs') {
            setDynamicVoices(null)
            return
        }
        let cancelled = false
        fetchVoices(api).then((voices) => {
            if (!cancelled) setDynamicVoices(voices.length > 0 ? voices : null)
        }).catch(() => {
            if (!cancelled) setDynamicVoices(null)
        })
        return () => { cancelled = true }
    }, [api, backend])

    const voices = useMemo<VoiceInfo[]>(() => {
        const fallback = getFallbackVoices(locale)
        if (backend === 'elevenlabs') {
            return dynamicVoices ?? fallback.map((voice) => ({ id: voice.id, name: voice.name, previewUrl: '', category: 'premade' }))
        }
        if (backend === 'gemini-live' || backend === 'qwen-realtime') {
            return getStaticVoiceOptions(backend).map((voice) => ({ id: voice.id, name: voice.label, description: voice.description, previewUrl: '', category: 'premade' }))
        }
        return fallback.map((voice) => ({ id: voice.id, name: voice.name, previewUrl: '', category: 'premade' }))
    }, [backend, dynamicVoices, locale])

    const setBackend = useCallback((value: VoiceBackendType) => {
        writeStoredVoiceBackendPreference(value)
        setBackendState(value)
        setVoiceIdState(readStoredVoiceSelection(value))
    }, [])

    const setVoice = useCallback((value: string | null) => {
        setVoiceIdState(value)
        writeStoredVoiceSelection(backend ?? 'elevenlabs', value)
    }, [backend])

    const setVoiceLanguage = useCallback((language: Language) => {
        setVoiceLanguageState(language.code)
        if (language.code === null) localStorage.removeItem('hapi-voice-lang')
        else localStorage.setItem('hapi-voice-lang', language.code)
    }, [])

    const stopPreview = useCallback(() => {
        audioRef.current?.pause()
        audioRef.current = null
        setPlayingVoiceId(null)
    }, [])

    const previewVoice = useCallback((voice: VoiceInfo) => {
        if (!voice.previewUrl || backend !== 'elevenlabs') return
        if (playingVoiceId === voice.id) {
            stopPreview()
            return
        }
        stopPreview()
        const audio = new Audio(voice.previewUrl)
        audioRef.current = audio
        setPlayingVoiceId(voice.id)
        audio.play().catch(stopPreview)
        audio.addEventListener('ended', stopPreview, { once: true })
    }, [backend, playingVoiceId, stopPreview])

    useEffect(() => stopPreview, [stopPreview])

    return {
        configuredBackends,
        backend,
        setBackend,
        voiceId,
        setVoice,
        voices,
        voiceLanguage,
        setVoiceLanguage,
        voiceLanguages: getElevenLabsSupportedLanguages(),
        playingVoiceId,
        previewVoice,
    }
}
