import { describe, expect, test } from 'bun:test'
import { VOICE_SYSTEM_PROMPT } from './voice'
import {
    ELEVENLABS_WEBRTC_CONTEXT_MAX_BYTES,
    getDefaultVoiceSystemPrompt,
    getVoicePersonalityPreset,
    isDefaultVoicePersonality,
    parseVoicePersonalityPreferences,
    resolveComposedVoiceSystemPrompt,
    resolveElevenLabsVoiceSettings,
    truncateUtf8ByteLength,
    utf8ByteLength
} from './voicePersonality'
import { VOICE_PLATFORM_FIXTURES } from './voicePromptLayers'

describe('voicePersonality', () => {
    test('parseVoicePersonalityPreferences returns defaults for invalid input', () => {
        const prefs = parseVoicePersonalityPreferences(null)
        expect(prefs.preset).toBe('balanced')
        expect(prefs.identity).toBe('')
        expect(prefs.character).toBe('')
    })

    test('migrates legacy customPrompt into character', () => {
        const prefs = parseVoicePersonalityPreferences({
            customPrompt: 'Call me G.'
        })
        expect(prefs.character).toBe('Call me G.')
    })

    test('migrates non-monolith systemPrompt into character', () => {
        const prefs = parseVoicePersonalityPreferences({
            systemPrompt: 'You are a pirate. Arr.'
        })
        expect(prefs.character).toBe('You are a pirate. Arr.')
        expect(prefs.systemPrompt).toBe('')
    })

    test('composed prompt always includes platform fixtures', () => {
        const prefs = parseVoicePersonalityPreferences({
            character: 'You are a pirate. Arr.'
        })
        const { prompt } = resolveComposedVoiceSystemPrompt(prefs)
        expect(prompt).toContain('messageCodingAgent')
        expect(prompt).toContain(VOICE_PLATFORM_FIXTURES.slice(0, 40))
        expect(prompt).toContain('You are a pirate')
        expect(prompt).toContain('Never refer to yourself as Gemini')
    })

    test('resolveComposedVoiceSystemPrompt does not embed session context', () => {
        const prefs = parseVoicePersonalityPreferences({ character: 'Base.' })
        const { prompt } = resolveComposedVoiceSystemPrompt(prefs)
        expect(prompt).not.toContain('[Current Context]')
        expect(prompt).not.toContain('Working on auth.')
    })

    test('getDefaultVoiceSystemPrompt matches bundled VOICE_SYSTEM_PROMPT', () => {
        const prefs = parseVoicePersonalityPreferences({})
        expect(getDefaultVoiceSystemPrompt()).toBe(VOICE_SYSTEM_PROMPT)
        expect(isDefaultVoicePersonality(prefs)).toBe(true)
    })

    test('resolveElevenLabsVoiceSettings uses preset sliders unless custom', () => {
        const prefs = parseVoicePersonalityPreferences({
            preset: 'custom',
            elevenLabs: { stability: 0.42, similarity_boost: 0.8, style: 0.2, speed: 1.05, use_speaker_boost: true }
        })
        expect(resolveElevenLabsVoiceSettings(prefs).stability).toBe(0.42)
    })

    test('defines all preset ids', () => {
        expect(getVoicePersonalityPreset('calm').elevenLabs.speed).toBeLessThan(1)
    })

    test('truncateUtf8ByteLength respects byte budget', () => {
        const text = truncateUtf8ByteLength('hello 🎙️ world', ELEVENLABS_WEBRTC_CONTEXT_MAX_BYTES)
        expect(text).toBe('hello 🎙️ world')
        const huge = truncateUtf8ByteLength('a'.repeat(50_000), 100)
        expect(utf8ByteLength(huge)).toBeLessThanOrEqual(100)
    })
})
