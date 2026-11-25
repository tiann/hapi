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

    test('custom voice id with default sliders emits tts.voiceId ONLY (SDK camelCase)', () => {
        const overrides = buildElevenLabsSessionOverridesFromPrefs(
            structuredClone(DEFAULT_VOICE_PERSONALITY),
            { language: 'en', voiceId: 'voice_abc' }
        )
        expect(overrides.agent).toEqual({ language: 'en' })
        // @elevenlabs/client constructOverrides reads overrides.tts.voiceId, not voice_id
        expect(overrides.tts).toEqual({ voiceId: 'voice_abc' })
        expect(overrides.tts).not.toHaveProperty('voice_id')
    })

    test('custom voice id with non-balanced preset emits camelCase sliders + voiceId', () => {
        const overrides = buildElevenLabsSessionOverridesFromPrefs(
            { ...DEFAULT_VOICE_PERSONALITY, preset: 'warm' },
            { language: 'en', voiceId: 'voice_abc' }
        )
        expect(overrides.tts?.voiceId).toBe('voice_abc')
        expect(overrides.tts?.stability).toBeDefined()
        expect(overrides.tts?.similarityBoost).toBeDefined()
        expect(overrides.tts).not.toHaveProperty('voice_id')
        expect(overrides.tts).not.toHaveProperty('similarity_boost')
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
        // warm raises expressiveness → similarityBoost / stability diverge from defaults
        expect(overrides.tts?.similarityBoost).toBeDefined()
        expect(
            Number(overrides.tts?.stability) !== DEFAULT_VOICE_PERSONALITY.elevenLabs.stability
            || Number(overrides.tts?.similarityBoost) !== DEFAULT_VOICE_PERSONALITY.elevenLabs.similarity_boost
            || Number(overrides.tts?.speed) !== DEFAULT_VOICE_PERSONALITY.elevenLabs.speed
        ).toBe(true)
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

    test('omits fields the ElevenLabs client SDK does not map from overrides.tts', () => {
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
        // 0.13 constructOverrides only forwards voiceId/speed/stability/similarityBoost
        expect(overrides.tts).not.toHaveProperty('use_speaker_boost')
        expect(overrides.tts).not.toHaveProperty('useSpeakerBoost')
        expect(overrides.tts).not.toHaveProperty('style')
        expect(overrides.tts?.stability).toBeDefined()
        expect(overrides.tts?.speed).toBeDefined()
        expect(overrides.tts?.similarityBoost).toBeDefined()
    })
})
