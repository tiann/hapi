/**
 * Hub-side provider credentials for dictation / voice backends.
 *
 * Priority: process env (ops bootstrap) > settings.json providerCredentials.
 * Env-locked keys cannot be overwritten or cleared from the Settings UI.
 * Settings-backed values are applied into process.env so existing discovery
 * helpers (listConfiguredTranscriptionProviders) keep working without restart.
 */

import { getSettingsFile, readSettings, writeSettings, type Settings } from './settings'

export const TRANSCRIPTION_CREDENTIAL_ENV_KEYS = [
    'OPENAI_API_KEY',
    'ELEVENLABS_API_KEY',
    'DEEPGRAM_API_KEY',
    'GROQ_API_KEY',
    'TRANSCRIPTION_BASE_URL',
    'TRANSCRIPTION_MODEL',
    'TRANSCRIPTION_API_KEY',
] as const

export type TranscriptionCredentialEnvKey = (typeof TRANSCRIPTION_CREDENTIAL_ENV_KEYS)[number]

export type ProviderCredentialSource = 'env' | 'settings' | 'none'

export interface MaskedCredentialStatus {
    configured: boolean
    source: ProviderCredentialSource
    hint: string | null
    editable: boolean
}

export interface OpenAICompatibleCredentialStatus {
    configured: boolean
    source: ProviderCredentialSource
    baseUrl: string | null
    model: string | null
    baseUrlEditable: boolean
    modelEditable: boolean
    apiKey: MaskedCredentialStatus
}

export interface TranscriptionCredentialStatus {
    openai: MaskedCredentialStatus
    elevenlabs: MaskedCredentialStatus
    deepgram: MaskedCredentialStatus
    groq: MaskedCredentialStatus
    openaiCompatible: OpenAICompatibleCredentialStatus
}

export interface TranscriptionCredentialsUpdate {
    openai?: string | null
    elevenlabs?: string | null
    deepgram?: string | null
    groq?: string | null
    openaiCompatible?: {
        baseUrl?: string | null
        model?: string | null
        apiKey?: string | null
    }
}

export type ProviderCredentialsMap = Partial<Record<TranscriptionCredentialEnvKey, string>>

let envLockedKeys = new Set<TranscriptionCredentialEnvKey>()

export function resetProviderCredentialEnvLocksForTests(): void {
    envLockedKeys = new Set()
}

export function maskSecret(value: string): string {
    const trimmed = value.trim()
    if (trimmed.length <= 4) return '••••'
    return `••••${trimmed.slice(-4)}`
}

function snapshotEnvLocks(env: NodeJS.ProcessEnv = process.env): void {
    envLockedKeys = new Set(
        TRANSCRIPTION_CREDENTIAL_ENV_KEYS.filter((key) => Boolean(env[key]?.trim()))
    )
}

function readProviderCredentials(settings: Settings | null): ProviderCredentialsMap {
    const raw = settings?.providerCredentials
    if (!raw || typeof raw !== 'object') return {}
    const out: ProviderCredentialsMap = {}
    for (const key of TRANSCRIPTION_CREDENTIAL_ENV_KEYS) {
        const value = raw[key]
        if (typeof value === 'string' && value.trim()) {
            out[key] = value.trim()
        }
    }
    return out
}

function statusForKey(
    key: TranscriptionCredentialEnvKey,
    stored: ProviderCredentialsMap
): MaskedCredentialStatus {
    if (envLockedKeys.has(key)) {
        const value = process.env[key]?.trim() ?? ''
        return {
            configured: Boolean(value),
            source: 'env',
            hint: value ? maskSecret(value) : null,
            editable: false,
        }
    }
    const value = stored[key] ?? process.env[key]?.trim()
    if (value) {
        return {
            configured: true,
            source: 'settings',
            hint: maskSecret(value),
            editable: true,
        }
    }
    return { configured: false, source: 'none', hint: null, editable: true }
}

function compatibleSource(
    baseUrl: MaskedCredentialStatus,
    model: MaskedCredentialStatus,
    apiKey: MaskedCredentialStatus
): ProviderCredentialSource {
    if (baseUrl.source === 'env' || model.source === 'env' || apiKey.source === 'env') return 'env'
    if (baseUrl.source === 'settings' || model.source === 'settings' || apiKey.source === 'settings') {
        return 'settings'
    }
    return 'none'
}

export async function applyProviderCredentialsFromSettings(dataDir: string): Promise<void> {
    snapshotEnvLocks()
    const settings = await readSettings(getSettingsFile(dataDir))
    if (settings === null) return
    const stored = readProviderCredentials(settings)
    for (const key of TRANSCRIPTION_CREDENTIAL_ENV_KEYS) {
        if (envLockedKeys.has(key)) continue
        const value = stored[key]
        if (value) process.env[key] = value
        else delete process.env[key]
    }
}

export async function getTranscriptionCredentialStatus(
    dataDir: string
): Promise<TranscriptionCredentialStatus> {
    const settings = await readSettings(getSettingsFile(dataDir))
    const stored = settings === null ? {} : readProviderCredentials(settings)
    const openai = statusForKey('OPENAI_API_KEY', stored)
    const elevenlabs = statusForKey('ELEVENLABS_API_KEY', stored)
    const deepgram = statusForKey('DEEPGRAM_API_KEY', stored)
    const groq = statusForKey('GROQ_API_KEY', stored)
    const baseUrl = statusForKey('TRANSCRIPTION_BASE_URL', stored)
    const model = statusForKey('TRANSCRIPTION_MODEL', stored)
    const apiKey = statusForKey('TRANSCRIPTION_API_KEY', stored)
    const baseUrlValue = process.env.TRANSCRIPTION_BASE_URL?.trim() || null
    const modelValue = process.env.TRANSCRIPTION_MODEL?.trim() || null
    return {
        openai,
        elevenlabs,
        deepgram,
        groq,
        openaiCompatible: {
            configured: Boolean(baseUrlValue && modelValue),
            source: compatibleSource(baseUrl, model, apiKey),
            baseUrl: baseUrlValue,
            model: modelValue,
            baseUrlEditable: baseUrl.editable,
            modelEditable: model.editable,
            apiKey,
        },
    }
}

function normalizeOptionalSecret(value: string | null | undefined): string | null | undefined {
    if (value === undefined) return undefined
    if (value === null) return null
    const trimmed = value.trim()
    return trimmed ? trimmed : null
}

function applyPatchToStored(
    stored: ProviderCredentialsMap,
    key: TranscriptionCredentialEnvKey,
    value: string | null | undefined
): void {
    if (value === undefined) return
    if (envLockedKeys.has(key)) {
        throw new Error(`${key} is set by an environment variable and cannot be changed from Settings`)
    }
    if (value === null) {
        delete stored[key]
        delete process.env[key]
        return
    }
    stored[key] = value
    process.env[key] = value
}

export async function updateTranscriptionCredentials(
    dataDir: string,
    update: TranscriptionCredentialsUpdate
): Promise<TranscriptionCredentialStatus> {
    const settingsFile = getSettingsFile(dataDir)
    const settings = await readSettings(settingsFile)
    if (settings === null) {
        throw new Error(`Cannot read ${settingsFile}. Please fix or remove the file and retry.`)
    }

    const stored = readProviderCredentials(settings)

    applyPatchToStored(stored, 'OPENAI_API_KEY', normalizeOptionalSecret(update.openai))
    applyPatchToStored(stored, 'ELEVENLABS_API_KEY', normalizeOptionalSecret(update.elevenlabs))
    applyPatchToStored(stored, 'DEEPGRAM_API_KEY', normalizeOptionalSecret(update.deepgram))
    applyPatchToStored(stored, 'GROQ_API_KEY', normalizeOptionalSecret(update.groq))

    if (update.openaiCompatible) {
        applyPatchToStored(
            stored,
            'TRANSCRIPTION_BASE_URL',
            normalizeOptionalSecret(update.openaiCompatible.baseUrl)
        )
        applyPatchToStored(
            stored,
            'TRANSCRIPTION_MODEL',
            normalizeOptionalSecret(update.openaiCompatible.model)
        )
        applyPatchToStored(
            stored,
            'TRANSCRIPTION_API_KEY',
            normalizeOptionalSecret(update.openaiCompatible.apiKey)
        )
    }

    settings.providerCredentials = stored
    await writeSettings(settingsFile, settings)
    return getTranscriptionCredentialStatus(dataDir)
}
