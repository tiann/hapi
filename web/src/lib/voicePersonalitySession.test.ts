import { describe, expect, test } from 'vitest'
import { DEFAULT_VOICE_PERSONALITY } from '@hapi/protocol/voice-personality'
import {
    buildElevenLabsSessionOverridesFromPrefs,
    capElevenLabsInitialContext
} from './voicePersonalitySession'

describe('buildElevenLabsSessionOverridesFromPrefs', () => {
    test('empty prefs + language produces byte-parity with upstream baseline', () => {
        const overrides = buildElevenLabsSessionOverridesFromPrefs(
            structuredClone(DEFAULT_VOICE_PERSONALITY),
            { language: 'en' }
        )
        expect(overrides).toEqual({ agent: { language: 'en' } })
    })

    test('empty prefs + no language produces empty overrides (no unauthorized fields)', () => {
        const overrides = buildElevenLabsSessionOverridesFromPrefs(
            structuredClone(DEFAULT_VOICE_PERSONALITY),
            {}
        )
        expect(overrides).toEqual({})
    })

    test('custom voice id with default sliders emits tts.voice_id ONLY', () => {
        const overrides = buildElevenLabsSessionOverridesFromPrefs(
            structuredClone(DEFAULT_VOICE_PERSONALITY),
            { language: 'en', voiceId: 'voice_abc' }
        )
        expect(overrides.agent).toEqual({ language: 'en' })
        expect(overrides.tts).toEqual({ voice_id: 'voice_abc' })
    })

    test('custom voice id with non-balanced preset emits sliders + voice_id', () => {
        const overrides = buildElevenLabsSessionOverridesFromPrefs(
            { ...DEFAULT_VOICE_PERSONALITY, preset: 'warm' },
            { language: 'en', voiceId: 'voice_abc' }
        )
        expect(overrides.tts?.voice_id).toBe('voice_abc')
        expect(overrides.tts?.stability).toBeDefined()
    })

    test('custom character emits composed prompt with client tools', () => {
        const overrides = buildElevenLabsSessionOverridesFromPrefs(
            {
                ...DEFAULT_VOICE_PERSONALITY,
                character: 'You are a pirate. Arr.'
            },
            { language: 'en' }
        )
        expect(overrides.agent?.language).toBe('en')
        expect(overrides.agent?.prompt?.prompt).toContain('You are a pirate')
        expect(overrides.agent?.prompt?.prompt).toContain('# CRITICAL RULE')
        expect(overrides.agent?.prompt?.tools?.length).toBeGreaterThan(0)
    })

    test('non-balanced preset emits tts slider override', () => {
        const overrides = buildElevenLabsSessionOverridesFromPrefs(
            { ...DEFAULT_VOICE_PERSONALITY, preset: 'warm' },
            { language: 'en' }
        )
        expect(overrides.tts?.style).toBeGreaterThan(DEFAULT_VOICE_PERSONALITY.elevenLabs.style)
    })

    test('balanced preset does not emit tts override', () => {
        const overrides = buildElevenLabsSessionOverridesFromPrefs(
            { ...DEFAULT_VOICE_PERSONALITY, preset: 'balanced' },
            { language: 'en' }
        )
        expect(overrides.tts).toBeUndefined()
    })

    test('caps initial context for WebRTC transport', () => {
        const huge = 'x'.repeat(100_000)
        const capped = capElevenLabsInitialContext(huge)
        expect(new TextEncoder().encode(capped).length).toBeLessThanOrEqual(4_500)
        expect(capped).toContain('truncated')
    })

    test('sends use_speaker_boost in tts override when set', () => {
        const overrides = buildElevenLabsSessionOverridesFromPrefs(
            {
                ...DEFAULT_VOICE_PERSONALITY,
                preset: 'warm',
                elevenLabs: {
                    ...DEFAULT_VOICE_PERSONALITY.elevenLabs,
                    use_speaker_boost: true
                }
            },
            { language: 'en' }
        )
        expect(overrides.tts).toHaveProperty('use_speaker_boost', true)
    })
})
