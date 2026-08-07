import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    applyProviderCredentialsFromSettings,
    getProviderEnvironment,
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

    it('exposes settings-backed keys via getProviderEnvironment without mutating process.env', async () => {
        dir = makeTempDir()
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({
            providerCredentials: {
                OPENAI_API_KEY: 'settings-openai-key',
                TRANSCRIPTION_BASE_URL: 'http://127.0.0.1:8000/v1',
                TRANSCRIPTION_MODEL: 'local-whisper',
            }
        }))

        await applyProviderCredentialsFromSettings(dir)

        expect(getProviderEnvironment().OPENAI_API_KEY).toBe('settings-openai-key')
        expect(process.env.OPENAI_API_KEY).toBeUndefined()
        expect(getProviderEnvironment().TRANSCRIPTION_BASE_URL).toBe('http://127.0.0.1:8000/v1')
        expect(getProviderEnvironment().TRANSCRIPTION_MODEL).toBe('local-whisper')
        expect(process.env.TRANSCRIPTION_BASE_URL).toBeUndefined()
        expect(process.env.TRANSCRIPTION_MODEL).toBeUndefined()
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
        expect(getProviderEnvironment().OPENAI_API_KEY).toBe('ui-openai-secret')
        expect(getProviderEnvironment().TRANSCRIPTION_BASE_URL).toBe('http://127.0.0.1:9000/v1')
        expect(process.env.OPENAI_API_KEY).toBeUndefined()
        expect(process.env.TRANSCRIPTION_BASE_URL).toBeUndefined()

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
        expect(getProviderEnvironment().OPENAI_API_KEY).toBeUndefined()
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
        expect(getProviderEnvironment().GEMINI_API_KEY).toBe('gemini-ui-key')
        expect(getProviderEnvironment().DASHSCOPE_API_KEY).toBe('dashscope-ui-key')
        expect(process.env.GEMINI_API_KEY).toBeUndefined()
        expect(process.env.DASHSCOPE_API_KEY).toBeUndefined()
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

    it('does not let settings GEMINI_API_KEY shadow env GOOGLE_API_KEY on apply', async () => {
        dir = makeTempDir()
        process.env.GOOGLE_API_KEY = 'env-google'
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({
            providerCredentials: { GEMINI_API_KEY: 'settings-gemini' }
        }))

        await applyProviderCredentialsFromSettings(dir)

        expect(process.env.GOOGLE_API_KEY).toBe('env-google')
        expect(process.env.GEMINI_API_KEY).toBeUndefined()
        expect(getProviderEnvironment().GEMINI_API_KEY).toBeUndefined()
        expect(getProviderEnvironment().GOOGLE_API_KEY).toBe('env-google')
        const status = await getTranscriptionCredentialStatus(dir)
        expect(status.voiceBackends.geminiLive).toEqual({
            configured: true,
            source: 'env',
            hint: '••••ogle',
            editable: false,
        })
    })

    it('does not let settings QWEN_API_KEY shadow env DASHSCOPE_API_KEY on apply', async () => {
        dir = makeTempDir()
        process.env.DASHSCOPE_API_KEY = 'env-dashscope'
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({
            providerCredentials: { QWEN_API_KEY: 'settings-qwen' }
        }))

        await applyProviderCredentialsFromSettings(dir)

        expect(process.env.DASHSCOPE_API_KEY).toBe('env-dashscope')
        expect(process.env.QWEN_API_KEY).toBeUndefined()
        expect(getProviderEnvironment().QWEN_API_KEY).toBeUndefined()
        expect(getProviderEnvironment().DASHSCOPE_API_KEY).toBe('env-dashscope')
    })

    it('omits undefined credential fields instead of clearing them', async () => {
        dir = makeTempDir()
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({}))
        await applyProviderCredentialsFromSettings(dir)
        await updateTranscriptionCredentials(dir, {
            openai: 'keep-me-secret',
            openaiCompatible: {
                baseUrl: 'http://127.0.0.1:8000/v1',
                model: 'whisper-large',
                apiKey: 'local-token',
            },
        })

        await updateTranscriptionCredentials(dir, {
            openai: undefined,
            openaiCompatible: {
                baseUrl: undefined,
                model: undefined,
                apiKey: 'rotated-token',
            },
        })

        expect(getProviderEnvironment().OPENAI_API_KEY).toBe('keep-me-secret')
        expect(getProviderEnvironment().TRANSCRIPTION_BASE_URL).toBe('http://127.0.0.1:8000/v1')
        expect(getProviderEnvironment().TRANSCRIPTION_MODEL).toBe('whisper-large')
        expect(getProviderEnvironment().TRANSCRIPTION_API_KEY).toBe('rotated-token')
        expect(process.env.OPENAI_API_KEY).toBeUndefined()
        expect(process.env.TRANSCRIPTION_API_KEY).toBeUndefined()
    })

    it('leaves process.env unchanged when a later field in the same update is env-locked', async () => {
        dir = makeTempDir()
        process.env.ELEVENLABS_API_KEY = 'env-eleven'
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({}))
        await applyProviderCredentialsFromSettings(dir)

        await expect(updateTranscriptionCredentials(dir, {
            openai: 'should-not-apply',
            elevenlabs: 'also-blocked',
        })).rejects.toThrow(/environment variable/)

        expect(getProviderEnvironment().OPENAI_API_KEY).toBeUndefined()
        expect(process.env.OPENAI_API_KEY).toBeUndefined()
        expect(process.env.ELEVENLABS_API_KEY).toBe('env-eleven')
    })

    it('does not sync overlay when settings write fails before afterCommit', async () => {
        dir = makeTempDir()
        const settingsFile = join(dir, 'settings.json')
        writeFileSync(settingsFile, JSON.stringify({}))
        await applyProviderCredentialsFromSettings(dir)

        // Unique tmp paths (#1376) mean occupying settings.json.tmp no longer
        // blocks writes. Sabotage rename instead: after the locked read, turn
        // settings.json into a directory so rename(tmp → settings) fails and
        // afterCommit (overlay sync) must not run.
        const { updateSettings } = await import('./settings')
        const { unlinkSync, mkdirSync } = await import('node:fs')
        let afterCommitRan = false
        await expect(
            updateSettings(settingsFile, (current) => {
                unlinkSync(settingsFile)
                mkdirSync(settingsFile)
                writeFileSync(join(settingsFile, 'blocker'), 'x')
                return {
                    settings: {
                        ...current,
                        providerCredentials: { OPENAI_API_KEY: 'disk-full-secret' },
                    },
                    result: undefined,
                    afterCommit: () => {
                        afterCommitRan = true
                    },
                }
            })
        ).rejects.toThrow()

        expect(afterCommitRan).toBe(false)
        expect(process.env.OPENAI_API_KEY).toBeUndefined()
        expect(getProviderEnvironment().OPENAI_API_KEY).toBeUndefined()
    })

    it('reports OpenAI-compatible fields independently editable under mixed env locks', async () => {
        dir = makeTempDir()
        process.env.TRANSCRIPTION_API_KEY = 'env-api-key'
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({
            providerCredentials: {
                TRANSCRIPTION_BASE_URL: 'http://127.0.0.1:8000/v1',
                TRANSCRIPTION_MODEL: 'whisper-large',
            }
        }))
        await applyProviderCredentialsFromSettings(dir)
        const status = await getTranscriptionCredentialStatus(dir)
        expect(status.openaiCompatible.apiKey.editable).toBe(false)
        expect(status.openaiCompatible.baseUrlEditable).toBe(true)
        expect(status.openaiCompatible.modelEditable).toBe(true)
    })

    it('serializes concurrent disjoint credential updates without losing either', async () => {
        dir = makeTempDir()
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({}))
        await applyProviderCredentialsFromSettings(dir)

        await Promise.all([
            updateTranscriptionCredentials(dir, { openai: 'concurrent-openai' }),
            updateTranscriptionCredentials(dir, { groq: 'concurrent-groq' }),
        ])

        expect(getProviderEnvironment().OPENAI_API_KEY).toBe('concurrent-openai')
        expect(getProviderEnvironment().GROQ_API_KEY).toBe('concurrent-groq')
        expect(process.env.OPENAI_API_KEY).toBeUndefined()
        expect(process.env.GROQ_API_KEY).toBeUndefined()
        const saved = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as {
            providerCredentials: Record<string, string>
        }
        expect(saved.providerCredentials.OPENAI_API_KEY).toBe('concurrent-openai')
        expect(saved.providerCredentials.GROQ_API_KEY).toBe('concurrent-groq')
    })

    it('preserves credentials when raced with relay-key persistence', async () => {
        dir = makeTempDir()
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({}))
        await applyProviderCredentialsFromSettings(dir)
        const { updateSettings, getSettingsFile } = await import('./settings')
        const settingsFile = getSettingsFile(dir)

        await Promise.all([
            updateTranscriptionCredentials(dir, { openai: 'race-openai' }),
            updateSettings(settingsFile, (settings) => ({
                settings: { ...settings, relayAuthKey: 'race-relay' },
                result: undefined,
            })),
        ])

        const saved = JSON.parse(readFileSync(settingsFile, 'utf8')) as {
            providerCredentials?: Record<string, string>
            relayAuthKey?: string
        }
        expect(saved.providerCredentials?.OPENAI_API_KEY).toBe('race-openai')
        expect(saved.relayAuthKey).toBe('race-relay')
        expect(getProviderEnvironment().OPENAI_API_KEY).toBe('race-openai')
        expect(process.env.OPENAI_API_KEY).toBeUndefined()
    })

    it('preserves hub credentials when raced with CLI-style settings lock writer', async () => {
        if (process.platform === 'win32') return
        dir = makeTempDir()
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({ machineId: 'keep-me' }))
        await applyProviderCredentialsFromSettings(dir)
        const { updateSettings, getSettingsFile, readSettings } = await import('./settings')
        const { withSettingsFileLock } = await import('@hapi/protocol/settingsFileLock')
        const { writeFile, chmod, rename, stat } = await import('node:fs/promises')
        const settingsFile = getSettingsFile(dir)

        await Promise.all([
            updateTranscriptionCredentials(dir, { openai: 'hub-cli-race' }),
            withSettingsFileLock(settingsFile, async () => {
                const current = (await readSettings(settingsFile)) ?? {}
                const updated = { ...current, apiUrl: 'http://cli-writer.example' }
                const tmpFile = `${settingsFile}.tmp`
                await writeFile(tmpFile, JSON.stringify(updated, null, 2), { mode: 0o600 })
                await chmod(tmpFile, 0o600)
                await rename(tmpFile, settingsFile)
                await chmod(settingsFile, 0o600)
            }),
        ])

        const saved = JSON.parse(readFileSync(settingsFile, 'utf8')) as {
            providerCredentials?: Record<string, string>
            machineId?: string
            apiUrl?: string
        }
        expect(saved.machineId).toBe('keep-me')
        expect(saved.apiUrl).toBe('http://cli-writer.example')
        expect(saved.providerCredentials?.OPENAI_API_KEY).toBe('hub-cli-race')
        expect((await stat(settingsFile)).mode & 0o777).toBe(0o600)
    })

    it('keeps partial OpenAI-compatible values queryable for clear UX', async () => {
        dir = makeTempDir()
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({}))
        await applyProviderCredentialsFromSettings(dir)
        await updateTranscriptionCredentials(dir, {
            openaiCompatible: { apiKey: 'partial-only-key' },
        })
        const status = await getTranscriptionCredentialStatus(dir)
        expect(status.openaiCompatible.configured).toBe(false)
        expect(status.openaiCompatible.apiKey.configured).toBe(true)
        expect(status.openaiCompatible.apiKey.hint).toBe('••••-key')
        expect(status.openaiCompatible.baseUrl).toBeNull()
        expect(status.openaiCompatible.model).toBeNull()
    })
})
