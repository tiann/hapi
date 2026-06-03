import { useCallback, useEffect, useState } from 'react'
import {
    DEFAULT_VOICE_PERSONALITY,
    VOICE_CHARACTER_MAX_LENGTH,
    VOICE_IDENTITY_MAX_LENGTH,
    VOICE_PERSONALITY_STORAGE_KEY,
    getPresetDeliverySnippet,
    getVoicePersonalityPreset,
    parseVoicePersonalityPreferences,
    type ElevenLabsVoiceSettings,
    type VoicePersonalityPreferences,
    type VoicePersonalityPresetId,
    type ResponseLengthOption
} from '@hapi/protocol/voice-personality'

function readStoredVoicePersonality(): VoicePersonalityPreferences {
    try {
        const raw = localStorage.getItem(VOICE_PERSONALITY_STORAGE_KEY)
        if (!raw) return structuredClone(DEFAULT_VOICE_PERSONALITY)
        return parseVoicePersonalityPreferences(JSON.parse(raw))
    } catch {
        return structuredClone(DEFAULT_VOICE_PERSONALITY)
    }
}

function writeStoredVoicePersonality(prefs: VoicePersonalityPreferences): void {
    localStorage.setItem(VOICE_PERSONALITY_STORAGE_KEY, JSON.stringify(prefs))
}

export function useVoicePersonality() {
    const [prefs, setPrefs] = useState<VoicePersonalityPreferences>(readStoredVoicePersonality)

    useEffect(() => {
        writeStoredVoicePersonality(prefs)
    }, [prefs])

    const setPreset = useCallback((preset: VoicePersonalityPresetId) => {
        setPrefs((prev) => {
            const definition = getVoicePersonalityPreset(preset)
            return {
                ...prev,
                preset,
                elevenLabs: preset === 'custom' ? prev.elevenLabs : { ...definition.elevenLabs }
            }
        })
    }, [])

    const setIdentity = useCallback((identity: string) => {
        setPrefs((prev) => ({
            ...prev,
            identity: identity.slice(0, VOICE_IDENTITY_MAX_LENGTH),
            systemPrompt: ''
        }))
    }, [])

    const setCharacter = useCallback((character: string) => {
        setPrefs((prev) => ({
            ...prev,
            character: character.slice(0, VOICE_CHARACTER_MAX_LENGTH),
            systemPrompt: ''
        }))
    }, [])

    const resetIdentity = useCallback(() => {
        setPrefs((prev) => ({ ...prev, identity: '' }))
    }, [])

    const resetCharacter = useCallback(() => {
        setPrefs((prev) => ({ ...prev, character: '' }))
    }, [])

    const resetVoicePersonalityLayers = useCallback(() => {
        setPrefs((prev) => ({
            ...prev,
            identity: '',
            character: '',
            systemPrompt: ''
        }))
    }, [])

    const appendPresetDeliveryToCharacter = useCallback(() => {
        setPrefs((prev) => {
            const snippet = getPresetDeliverySnippet(prev.preset).trim()
            if (!snippet) return prev
            const base = prev.character.trim()
            const merged = base.includes(snippet) ? base : (base ? `${base}\n\n${snippet}` : snippet)
            return {
                ...prev,
                character: merged.slice(0, VOICE_CHARACTER_MAX_LENGTH),
                systemPrompt: ''
            }
        })
    }, [])

    const setElevenLabs = useCallback((patch: Partial<ElevenLabsVoiceSettings>) => {
        setPrefs((prev) => ({
            ...prev,
            preset: 'custom',
            elevenLabs: { ...prev.elevenLabs, ...patch }
        }))
    }, [])

    const setGeminiAffectiveDialog = useCallback((affective_dialog: boolean) => {
        setPrefs((prev) => ({
            ...prev,
            gemini: { ...prev.gemini, affective_dialog }
        }))
    }, [])

    const setResponseLength = useCallback((responseLength: ResponseLengthOption) => {
        setPrefs((prev) => ({ ...prev, responseLength }))
    }, [])

    return {
        prefs,
        setPreset,
        setIdentity,
        setCharacter,
        resetIdentity,
        resetCharacter,
        resetVoicePersonalityLayers,
        appendPresetDeliveryToCharacter,
        setElevenLabs,
        setGeminiAffectiveDialog,
        setResponseLength
    }
}

export function loadVoicePersonalityFromStorage(): VoicePersonalityPreferences {
    return readStoredVoicePersonality()
}
