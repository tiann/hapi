import { describe, expect, test } from 'bun:test'
import {
    buildVoiceAgentConfig,
    listConfiguredTranscriptionProviders,
    listConfiguredVoiceBackends,
    resolveEffectiveVoiceBackend,
    resolveVoiceMaxDurationSeconds,
    resolveHubVoiceBackend
} from './voice'

describe('listConfiguredTranscriptionProviders', () => {
    test('returns configured providers with honest mode capabilities', () => {
        expect(listConfiguredTranscriptionProviders({
            OPENAI_API_KEY: 'openai',
            ELEVENLABS_API_KEY: 'elevenlabs',
            DEEPGRAM_API_KEY: 'deepgram',
            GROQ_API_KEY: 'groq',
            TRANSCRIPTION_BASE_URL: 'http://localhost:8000/v1',
            TRANSCRIPTION_MODEL: 'whisper-large-v3'
        })).toEqual([
            { id: 'openai', label: 'OpenAI', modes: ['standard', 'realtime'] },
            { id: 'elevenlabs', label: 'ElevenLabs', modes: ['standard', 'realtime'] },
            { id: 'deepgram', label: 'Deepgram', modes: ['standard', 'realtime'] },
            { id: 'groq', label: 'Groq', modes: ['standard'] },
            { id: 'openai-compatible', label: 'OpenAI-compatible / local', modes: ['standard'] }
        ])
    })

    test('does not advertise incomplete or missing configuration', () => {
        expect(listConfiguredTranscriptionProviders({ TRANSCRIPTION_BASE_URL: 'http://localhost:8000/v1' })).toEqual([])
    })
})

describe('listConfiguredVoiceBackends', () => {
    test('returns only backends with API keys', () => {
        const backends = listConfiguredVoiceBackends({
            ELEVENLABS_API_KEY: 'el',
            GEMINI_API_KEY: 'gm',
            DASHSCOPE_API_KEY: 'qw'
        })
        expect(backends).toEqual(['elevenlabs', 'gemini-live', 'qwen-realtime'])
    })

    test('returns empty when no keys configured', () => {
        expect(listConfiguredVoiceBackends({})).toEqual([])
    })
})

describe('buildVoiceAgentConfig', () => {
    test('includes ElevenLabs session context placeholder for dynamicVariables', () => {
        const prompt = buildVoiceAgentConfig().conversation_config.agent.prompt.prompt
        expect(prompt).toContain('{{initialConversationContext}}')
    })
})

describe('resolveHubVoiceBackend', () => {
    test('uses VOICE_BACKEND when that backend is configured', () => {
        const backend = resolveHubVoiceBackend({
            VOICE_BACKEND: 'gemini-live',
            GEMINI_API_KEY: 'gm',
            ELEVENLABS_API_KEY: 'el'
        })
        expect(backend).toBe('gemini-live')
    })

    test('falls back to first configured when VOICE_BACKEND unavailable', () => {
        const backend = resolveHubVoiceBackend({
            VOICE_BACKEND: 'qwen-realtime',
            ELEVENLABS_API_KEY: 'el'
        })
        expect(backend).toBe('elevenlabs')
    })

    test('returns null when no backends configured', () => {
        expect(resolveHubVoiceBackend({})).toBeNull()
    })
})

describe('resolveEffectiveVoiceBackend', () => {
    const configured = ['elevenlabs', 'gemini-live'] as const

    test('prefers stored preference when configured', () => {
        expect(resolveEffectiveVoiceBackend(configured, 'gemini-live', 'elevenlabs')).toBe('elevenlabs')
    })

    test('uses hub default when preference missing or invalid', () => {
        expect(resolveEffectiveVoiceBackend(configured, 'gemini-live', null)).toBe('gemini-live')
        expect(resolveEffectiveVoiceBackend(configured, 'gemini-live', 'qwen-realtime')).toBe('gemini-live')
    })

    test('returns null when no backends configured', () => {
        expect(resolveEffectiveVoiceBackend([], null, null)).toBeNull()
    })
})

describe('resolveVoiceMaxDurationSeconds', () => {
    test('defaults to 1800s when unset or blank', () => {
        expect(resolveVoiceMaxDurationSeconds(undefined)).toBe(1800)
        expect(resolveVoiceMaxDurationSeconds('  ')).toBe(1800)
    })

    test('accepts the inclusive 60..7200 range', () => {
        expect(resolveVoiceMaxDurationSeconds('60')).toBe(60)
        expect(resolveVoiceMaxDurationSeconds(' 7200 ')).toBe(7200)
    })

    test('rejects out-of-range and non-integer values', () => {
        for (const bad of ['59', '7201', '0', '-1', 'abc', '1800.5']) {
            expect(() => resolveVoiceMaxDurationSeconds(bad)).toThrow(/between 60 and 7200/)
        }
    })
})

describe('buildVoiceAgentConfig max duration', () => {
    test('omits conversation cap unless requested, includes it when given', () => {
        expect(buildVoiceAgentConfig().conversation_config.conversation).toBeUndefined()
        expect(buildVoiceAgentConfig({ maxDurationSeconds: 900 }).conversation_config.conversation)
            .toEqual({ max_duration_seconds: 900 })
    })
})
