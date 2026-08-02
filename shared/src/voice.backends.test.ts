import { describe, expect, test } from 'bun:test'
import {
    listConfiguredVoiceBackends,
    resolveEffectiveVoiceBackend,
    resolveHubVoiceBackend
} from './voice'

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
