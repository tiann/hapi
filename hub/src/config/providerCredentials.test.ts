import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    applyProviderCredentialsFromSettings,
    getTranscriptionCredentialStatus,
    maskSecret,
    resetProviderCredentialEnvLocksForTests,
    updateTranscriptionCredentials,
} from './providerCredentials'

const MANAGED_KEYS = [
    'OPENAI_API_KEY',
    'ELEVENLABS_API_KEY',
    'DEEPGRAM_API_KEY',
    'GROQ_API_KEY',
    'TRANSCRIPTION_BASE_URL',
    'TRANSCRIPTION_MODEL',
    'TRANSCRIPTION_API_KEY',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'DASHSCOPE_API_KEY',
    'QWEN_API_KEY',
] as const

function makeTempDir(): string {
    return mkdtempSync(join(tmpdir(), 'hapi-provider-creds-'))
}

describe('providerCredentials', () => {
    let dir: string | null = null
    const previous = new Map<string, string | undefined>()

    beforeEach(() => {
        for (const key of MANAGED_KEYS) {
            previous.set(key, process.env[key])
            delete process.env[key]
        }
        resetProviderCredentialEnvLocksForTests()
    })

    afterEach(() => {
        for (const key of MANAGED_KEYS) {
            const value = previous.get(key)
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
        resetProviderCredentialEnvLocksForTests()
        if (dir) {
            rmSync(dir, { recursive: true, force: true })
            dir = null
        }
    })

    it('masks secrets with last four characters only', () => {
        expect(maskSecret('sk-abcdefghij')).toBe('••••ghij')
        expect(maskSecret('ab')).toBe('••••')
    })

    it('applies settings-backed keys into process.env when env is unset', async () => {
        dir = makeTempDir()
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({
            providerCredentials: {
                OPENAI_API_KEY: 'settings-openai-key',
                TRANSCRIPTION_BASE_URL: 'http://127.0.0.1:8000/v1',
                TRANSCRIPTION_MODEL: 'local-whisper',
            }
        }))

        await applyProviderCredentialsFromSettings(dir)

        expect(process.env.OPENAI_API_KEY).toBe('settings-openai-key')
        expect(process.env.TRANSCRIPTION_BASE_URL).toBe('http://127.0.0.1:8000/v1')
        expect(process.env.TRANSCRIPTION_MODEL).toBe('local-whisper')
    })

    it('does not override env-provided keys with settings values', async () => {
        dir = makeTempDir()
        process.env.OPENAI_API_KEY = 'env-openai-key'
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({
            providerCredentials: { OPENAI_API_KEY: 'settings-openai-key' }
        }))

        await applyProviderCredentialsFromSettings(dir)

        expect(process.env.OPENAI_API_KEY).toBe('env-openai-key')
        const status = await getTranscriptionCredentialStatus(dir)
        expect(status.openai).toEqual({
            configured: true,
            source: 'env',
            hint: '••••-key',
            editable: false,
        })
    })

    it('persists UI updates to settings and applies them live', async () => {
        dir = makeTempDir()
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({}))
        await applyProviderCredentialsFromSettings(dir)

        const status = await updateTranscriptionCredentials(dir, {
            openai: 'ui-openai-secret',
            openaiCompatible: {
                baseUrl: 'http://127.0.0.1:9000/v1',
                model: 'whisper-large',
                apiKey: 'local-token',
            }
        })

        expect(status.openai.configured).toBe(true)
        expect(status.openai.source).toBe('settings')
        expect(status.openai.hint).toBe('••••cret')
        expect(status.openai.editable).toBe(true)
        expect(status.openaiCompatible.baseUrl).toBe('http://127.0.0.1:9000/v1')
        expect(status.openaiCompatible.model).toBe('whisper-large')
        expect(status.openaiCompatible.apiKey.configured).toBe(true)
        expect(process.env.OPENAI_API_KEY).toBe('ui-openai-secret')
        expect(process.env.TRANSCRIPTION_BASE_URL).toBe('http://127.0.0.1:9000/v1')

        const saved = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as {
            providerCredentials: Record<string, string>
        }
        expect(saved.providerCredentials.OPENAI_API_KEY).toBe('ui-openai-secret')
        expect(saved.providerCredentials.TRANSCRIPTION_API_KEY).toBe('local-token')
    })

    it('clears settings-backed keys and refuses to clear env-locked keys', async () => {
        dir = makeTempDir()
        process.env.ELEVENLABS_API_KEY = 'env-eleven'
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({
            providerCredentials: { OPENAI_API_KEY: 'settings-openai' }
        }))
        await applyProviderCredentialsFromSettings(dir)

        await updateTranscriptionCredentials(dir, { openai: null })
        expect(process.env.OPENAI_API_KEY).toBeUndefined()

        await expect(updateTranscriptionCredentials(dir, { elevenlabs: null })).rejects.toThrow(
            /environment variable/
        )
        expect(process.env.ELEVENLABS_API_KEY).toBe('env-eleven')
    })

    it('persists Gemini and Qwen voice backend keys and discovers them live', async () => {
        dir = makeTempDir()
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({}))
        await applyProviderCredentialsFromSettings(dir)

        const status = await updateTranscriptionCredentials(dir, {
            geminiLive: 'gemini-ui-key',
            qwenRealtime: 'dashscope-ui-key',
        })

        expect(status.voiceBackends.geminiLive).toEqual({
            configured: true,
            source: 'settings',
            hint: '••••-key',
            editable: true,
        })
        expect(status.voiceBackends.qwenRealtime.configured).toBe(true)
        expect(process.env.GEMINI_API_KEY).toBe('gemini-ui-key')
        expect(process.env.DASHSCOPE_API_KEY).toBe('dashscope-ui-key')
        expect(process.env.GOOGLE_API_KEY).toBeUndefined()
        expect(process.env.QWEN_API_KEY).toBeUndefined()
    })

    it('refuses to overwrite GOOGLE_API_KEY-locked Gemini via Settings', async () => {
        dir = makeTempDir()
        process.env.GOOGLE_API_KEY = 'env-google'
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({}))
        await applyProviderCredentialsFromSettings(dir)

        await expect(updateTranscriptionCredentials(dir, { geminiLive: 'ui' })).rejects.toThrow(
            /environment variable/
        )
        expect(process.env.GOOGLE_API_KEY).toBe('env-google')
    })
})
