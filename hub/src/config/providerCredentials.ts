/**
 * Hub-side provider credentials for dictation + voice-assistant backends.
 *
 * Priority: process env (ops bootstrap) > settings.json providerCredentials.
 * Env-locked keys cannot be overwritten or cleared from the Settings UI.
 * Settings-backed values live in an in-memory overlay exposed via
 * `getProviderEnvironment()` — they are never copied into `process.env`.
 */

import { getSettingsFile, readSettings, updateSettings, type Settings } from './settings'

export const PROVIDER_CREDENTIAL_ENV_KEYS = [
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

/** @deprecated use PROVIDER_CREDENTIAL_ENV_KEYS */
export const TRANSCRIPTION_CREDENTIAL_ENV_KEYS = PROVIDER_CREDENTIAL_ENV_KEYS

export type ProviderCredentialEnvKey = (typeof PROVIDER_CREDENTIAL_ENV_KEYS)[number]
export type TranscriptionCredentialEnvKey = ProviderCredentialEnvKey

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
    voiceBackends: {
        elevenlabs: MaskedCredentialStatus
        geminiLive: MaskedCredentialStatus
        qwenRealtime: MaskedCredentialStatus
    }
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
    geminiLive?: string | null
    qwenRealtime?: string | null
}

export type ProviderCredentialsMap = Partial<Record<ProviderCredentialEnvKey, string>>

let envLockedKeys = new Set<ProviderCredentialEnvKey>()

export function resetProviderCredentialEnvLocksForTests(): void {
    envLockedKeys = new Set()
    settingsBackedCredentials = {}
}

export function maskSecret(value: string): string {
    const trimmed = value.trim()
    if (trimmed.length <= 4) return '••••'
    return `••••${trimmed.slice(-4)}`
}

let settingsBackedCredentials: ProviderCredentialsMap = {}

function setSettingsBackedCredentials(stored: ProviderCredentialsMap): void {
    const next: ProviderCredentialsMap = {}
    for (const key of PROVIDER_CREDENTIAL_ENV_KEYS) {
        if (isLogicallyEnvLocked(key)) continue
        const value = stored[key]
        if (value) next[key] = value
    }
    settingsBackedCredentials = next
}

/**
 * Effective provider credential environment for voice/dictation paths only.
 * Settings-backed secrets stay out of `process.env` so unrelated child processes
 * (tunnel, Cursor ACP, Codex helpers) do not inherit them.
 */
export function getProviderEnvironment(
    env: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
    return { ...env, ...settingsBackedCredentials }
}

function snapshotEnvLocks(env: NodeJS.ProcessEnv = process.env): void {
    envLockedKeys = new Set(
        PROVIDER_CREDENTIAL_ENV_KEYS.filter((key) => Boolean(env[key]?.trim()))
    )
}

/** Alias pairs share one logical lock so a saved GEMINI cannot shadow env GOOGLE (and vice versa). */
function isLogicallyEnvLocked(key: ProviderCredentialEnvKey): boolean {
    if (key === 'GEMINI_API_KEY' || key === 'GOOGLE_API_KEY') {
        return envLockedKeys.has('GEMINI_API_KEY') || envLockedKeys.has('GOOGLE_API_KEY')
    }
    if (key === 'DASHSCOPE_API_KEY' || key === 'QWEN_API_KEY') {
        return envLockedKeys.has('DASHSCOPE_API_KEY') || envLockedKeys.has('QWEN_API_KEY')
    }
    return envLockedKeys.has(key)
}

function readProviderCredentials(settings: Settings | null): ProviderCredentialsMap {
    const raw = settings?.providerCredentials
    if (!raw || typeof raw !== 'object') return {}
    const out: ProviderCredentialsMap = {}
    for (const key of PROVIDER_CREDENTIAL_ENV_KEYS) {
        const value = raw[key]
        if (typeof value === 'string' && value.trim()) {
            out[key] = value.trim()
        }
    }
    return out
}

function statusForKey(
    key: ProviderCredentialEnvKey,
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

/** Gemini accepts GEMINI_API_KEY or GOOGLE_API_KEY; Qwen accepts DASHSCOPE or QWEN. */
function statusForAliasPair(
    primary: ProviderCredentialEnvKey,
    secondary: ProviderCredentialEnvKey,
    stored: ProviderCredentialsMap
): MaskedCredentialStatus {
    const primaryLocked = envLockedKeys.has(primary)
    const secondaryLocked = envLockedKeys.has(secondary)
    if (primaryLocked || secondaryLocked) {
        const value = (process.env[primary] ?? process.env[secondary] ?? '').trim()
        return {
            configured: Boolean(value),
            source: 'env',
            hint: value ? maskSecret(value) : null,
            editable: false,
        }
    }
    const value = (
        stored[primary]
        ?? stored[secondary]
        ?? process.env[primary]
        ?? process.env[secondary]
        ?? ''
    ).trim()
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
    if (settings === null) {
        setSettingsBackedCredentials({})
        return
    }
    setSettingsBackedCredentials(readProviderCredentials(settings))
}

function buildStatus(stored: ProviderCredentialsMap): TranscriptionCredentialStatus {
    const openai = statusForKey('OPENAI_API_KEY', stored)
    const elevenlabs = statusForKey('ELEVENLABS_API_KEY', stored)
    const deepgram = statusForKey('DEEPGRAM_API_KEY', stored)
    const groq = statusForKey('GROQ_API_KEY', stored)
    const baseUrl = statusForKey('TRANSCRIPTION_BASE_URL', stored)
    const model = statusForKey('TRANSCRIPTION_MODEL', stored)
    const apiKey = statusForKey('TRANSCRIPTION_API_KEY', stored)
    const env = getProviderEnvironment()
    const baseUrlValue = env.TRANSCRIPTION_BASE_URL?.trim() || null
    const modelValue = env.TRANSCRIPTION_MODEL?.trim() || null
    const geminiLive = statusForAliasPair('GEMINI_API_KEY', 'GOOGLE_API_KEY', stored)
    const qwenRealtime = statusForAliasPair('DASHSCOPE_API_KEY', 'QWEN_API_KEY', stored)
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
        voiceBackends: {
            elevenlabs,
            geminiLive,
            qwenRealtime,
        },
    }
}

export async function getTranscriptionCredentialStatus(
    dataDir: string
): Promise<TranscriptionCredentialStatus> {
    const settings = await readSettings(getSettingsFile(dataDir))
    const stored = settings === null ? {} : readProviderCredentials(settings)
    return buildStatus(stored)
}

function normalizeOptionalSecret(value: string | null | undefined): string | null | undefined {
    if (value === undefined) return undefined
    if (value === null) return null
    const trimmed = value.trim()
    return trimmed ? trimmed : null
}

function applyPatchToStored(
    stored: ProviderCredentialsMap,
    key: ProviderCredentialEnvKey,
    value: string | null | undefined
): void {
    if (value === undefined) return
    if (isLogicallyEnvLocked(key)) {
        throw new Error(`${key} is set by an environment variable and cannot be changed from Settings`)
    }
    if (value === null) {
        delete stored[key]
        return
    }
    stored[key] = value
}

function applyAliasPairPatch(
    stored: ProviderCredentialsMap,
    primary: ProviderCredentialEnvKey,
    secondary: ProviderCredentialEnvKey,
    value: string | null | undefined
): void {
    if (value === undefined) return
    if (isLogicallyEnvLocked(primary) || isLogicallyEnvLocked(secondary)) {
        throw new Error(
            `${primary} (or ${secondary}) is set by an environment variable and cannot be changed from Settings`
        )
    }
    if (value === null) {
        delete stored[primary]
        delete stored[secondary]
        return
    }
    // Canonical primary; drop secondary settings entry so one source of truth
    stored[primary] = value
    delete stored[secondary]
}

/** Refresh the in-memory overlay after a successful persist (never touches process.env). */
function syncSettingsCredentialsOverlay(stored: ProviderCredentialsMap): void {
    setSettingsBackedCredentials(stored)
}

export async function updateTranscriptionCredentials(
    dataDir: string,
    update: TranscriptionCredentialsUpdate
): Promise<TranscriptionCredentialStatus> {
    const settingsFile = getSettingsFile(dataDir)
    return updateSettings(settingsFile, async (settings) => {
        const nextStored: ProviderCredentialsMap = { ...readProviderCredentials(settings) }

        applyPatchToStored(nextStored, 'OPENAI_API_KEY', normalizeOptionalSecret(update.openai))
        applyPatchToStored(nextStored, 'ELEVENLABS_API_KEY', normalizeOptionalSecret(update.elevenlabs))
        applyPatchToStored(nextStored, 'DEEPGRAM_API_KEY', normalizeOptionalSecret(update.deepgram))
        applyPatchToStored(nextStored, 'GROQ_API_KEY', normalizeOptionalSecret(update.groq))

        if (update.openaiCompatible) {
            applyPatchToStored(
                nextStored,
                'TRANSCRIPTION_BASE_URL',
                normalizeOptionalSecret(update.openaiCompatible.baseUrl)
            )
            applyPatchToStored(
                nextStored,
                'TRANSCRIPTION_MODEL',
                normalizeOptionalSecret(update.openaiCompatible.model)
            )
            applyPatchToStored(
                nextStored,
                'TRANSCRIPTION_API_KEY',
                normalizeOptionalSecret(update.openaiCompatible.apiKey)
            )
        }

        applyAliasPairPatch(
            nextStored,
            'GEMINI_API_KEY',
            'GOOGLE_API_KEY',
            normalizeOptionalSecret(update.geminiLive)
        )
        applyAliasPairPatch(
            nextStored,
            'DASHSCOPE_API_KEY',
            'QWEN_API_KEY',
            normalizeOptionalSecret(update.qwenRealtime)
        )

        return {
            settings: { ...settings, providerCredentials: nextStored },
            result: nextStored,
            afterCommit: () => {
                syncSettingsCredentialsOverlay(nextStored)
            },
        }
    }).then((nextStored) => buildStatus(nextStored))
}
