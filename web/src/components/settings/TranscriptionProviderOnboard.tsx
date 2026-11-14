import { useCallback, useEffect, useState } from 'react'
import { ApiError, type ApiClient, type TranscriptionCredentialStatus, type TranscriptionCredentialsUpdate } from '@/api/client'
import { useTranslation } from '@/lib/use-translation'
import { SelectControl } from '@/components/ui/select-control'
import { Button } from '@/components/ui/button'
import {
    VOICE_MAX_DURATION_DEFAULT_SECONDS,
    VOICE_MAX_DURATION_MAX_SECONDS,
    VOICE_MAX_DURATION_MIN_SECONDS
} from '@hapi/protocol/voice'
import { DICTATION_PROVIDER_PRESETS, dictationOnboardProviders, hasOpenAICompatibleCredentials, type DictationProviderPreset } from './transcriptionProviders'

type DictationProvider = DictationProviderPreset | 'deepgram' | 'openai-compatible'
type AssistantProvider = 'elevenlabs' | 'gemini-live' | 'qwen-realtime'
type CloudProvider = DictationProvider | AssistantProvider

const ASSISTANT_PROVIDERS: AssistantProvider[] = [
    'elevenlabs',
    'gemini-live',
    'qwen-realtime',
]

function providerLabel(provider: CloudProvider, t: (key: string) => string): string {
    switch (provider) {
        case 'openai':
            return 'OpenAI'
        case 'elevenlabs':
            return 'ElevenLabs'
        case 'groq':
            return 'Groq'
        case 'deepgram':
            return 'Deepgram'
        case 'openai-compatible':
            return t('settings.voice.credentials.openaiCompatible')
        case 'gemini-live':
            return t('settings.voice.credentials.geminiLive')
        case 'qwen-realtime':
            return t('settings.voice.credentials.qwenRealtime')
    }
}

function statusForProvider(
    status: TranscriptionCredentialStatus | null,
    provider: CloudProvider
): { configured: boolean; hint: string | null; source: string; editable: boolean } | null {
    if (!status) return null
    if (provider === 'openai-compatible') {
        const compatible = status.openaiCompatible
        return {
            configured: compatible.configured,
            hint: compatible.apiKey.hint,
            source: compatible.source,
            editable: compatible.baseUrlEditable
                || compatible.modelEditable
                || compatible.apiKey.editable,
        }
    }
    if (provider === 'gemini-live') return status.voiceBackends.geminiLive
    if (provider === 'qwen-realtime') return status.voiceBackends.qwenRealtime
    if (provider === 'elevenlabs') return status.elevenlabs
    return status[provider]
}

function errorMessage(err: unknown, fallback: string): string {
    if (err instanceof ApiError && err.body) {
        try {
            const parsed = JSON.parse(err.body) as { error?: unknown }
            if (typeof parsed.error === 'string' && parsed.error.trim()) return parsed.error
        } catch {
            // fall through
        }
    }
    return err instanceof Error ? err.message : fallback
}

export function TranscriptionProviderOnboard(props: {
    api: ApiClient
    mode: 'dictation' | 'assistant'
    onConfigured: () => void
}) {
    const { t } = useTranslation()
    const [status, setStatus] = useState<TranscriptionCredentialStatus | null>(null)
    const [provider, setProvider] = useState<CloudProvider>(props.mode === 'assistant' ? ASSISTANT_PROVIDERS[0]! : DICTATION_PROVIDER_PRESETS[0]!)
    const [apiKey, setApiKey] = useState('')
    const [baseUrl, setBaseUrl] = useState('')
    const [model, setModel] = useState('')
    const [maxDurationInput, setMaxDurationInput] = useState('')
    const [maxDurationBusy, setMaxDurationBusy] = useState(false)
    const [maxDurationError, setMaxDurationError] = useState<string | null>(null)
    const [maxDurationMessage, setMaxDurationMessage] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [message, setMessage] = useState<string | null>(null)

    const providers: CloudProvider[] = props.mode === 'assistant'
        ? ASSISTANT_PROVIDERS
        : dictationOnboardProviders(
            status?.deepgram.configured ?? false,
            hasOpenAICompatibleCredentials(status)
        )

    useEffect(() => {
        setProvider(props.mode === 'assistant' ? ASSISTANT_PROVIDERS[0]! : DICTATION_PROVIDER_PRESETS[0]!)
        setApiKey('')
        setError(null)
        setMessage(null)
    }, [props.mode])

    // If the selected provider left the list (e.g. its credentials were cleared),
    // fall back to the mode-appropriate first option.
    useEffect(() => {
        if (!providers.some((option) => option === provider)) {
            setProvider(props.mode === 'assistant' ? ASSISTANT_PROVIDERS[0]! : DICTATION_PROVIDER_PRESETS[0]!)
        }
    }, [providers, provider, props.mode])

    const reload = useCallback(async () => {
        try {
            const next = await props.api.fetchTranscriptionCredentials()
            setStatus(next)
            // Seed editable endpoint fields so Save does not treat blanks as Clear.
            if (next.openaiCompatible.baseUrlEditable && next.openaiCompatible.baseUrl) {
                setBaseUrl(next.openaiCompatible.baseUrl)
            }
            if (next.openaiCompatible.modelEditable && next.openaiCompatible.model) {
                setModel(next.openaiCompatible.model)
            }
            setMaxDurationInput(String(next.elevenLabsMaxDurationSeconds?.value ?? VOICE_MAX_DURATION_DEFAULT_SECONDS))
        } catch {
            setStatus(null)
        }
    }, [props.api])

    useEffect(() => {
        void reload()
    }, [reload])

    const selected = statusForProvider(status, provider)
    const compatible = status?.openaiCompatible
    const baseUrlEditable = compatible?.baseUrlEditable !== false
    const modelEditable = compatible?.modelEditable !== false
    const apiKeyEditable = provider === 'openai-compatible'
        ? compatible?.apiKey.editable !== false
        : selected?.editable !== false

    const buildUpdate = (clear: boolean): TranscriptionCredentialsUpdate => {
        // Empty password/fields mean "leave unchanged" (undefined). Only Clear sends null.
        const value = clear ? null : (apiKey.trim() || undefined)
        if (provider === 'openai-compatible') {
            if (clear) {
                return {
                    openaiCompatible: {
                        baseUrl: baseUrlEditable ? null : undefined,
                        model: modelEditable ? null : undefined,
                        apiKey: apiKeyEditable ? null : undefined,
                    },
                }
            }
            return {
                openaiCompatible: {
                    baseUrl: baseUrlEditable ? (baseUrl.trim() || undefined) : undefined,
                    model: modelEditable ? (model.trim() || undefined) : undefined,
                    apiKey: apiKeyEditable ? value : undefined,
                },
            }
        }
        if (provider === 'gemini-live') return { geminiLive: value }
        if (provider === 'qwen-realtime') return { qwenRealtime: value }
        if (provider === 'elevenlabs') return { elevenlabs: value }
        if (provider === 'openai') return { openai: value }
        if (provider === 'deepgram') return { deepgram: value }
        return { groq: value }
    }

    const syncCompatibleFields = (next: TranscriptionCredentialStatus) => {
        setApiKey('')
        if (next.openaiCompatible.baseUrlEditable) {
            setBaseUrl(next.openaiCompatible.baseUrl ?? '')
        }
        if (next.openaiCompatible.modelEditable) {
            setModel(next.openaiCompatible.model ?? '')
        }
        setMaxDurationInput(String(next.elevenLabsMaxDurationSeconds?.value ?? VOICE_MAX_DURATION_DEFAULT_SECONDS))
    }

    const save = async () => {
        setBusy(true)
        setError(null)
        setMessage(null)
        try {
            const next = await props.api.updateTranscriptionCredentials(buildUpdate(false))
            setStatus(next)
            syncCompatibleFields(next)
            setMessage(t('settings.voice.credentials.saved'))
            props.onConfigured()
        } catch (err) {
            setError(errorMessage(err, t('settings.voice.credentials.saveFailed')))
        } finally {
            setBusy(false)
        }
    }

    const clear = async () => {
        if (!selected?.editable) return
        setBusy(true)
        setError(null)
        setMessage(null)
        try {
            const next = await props.api.updateTranscriptionCredentials(buildUpdate(true))
            setStatus(next)
            syncCompatibleFields(next)
            setMessage(t('settings.voice.credentials.cleared'))
            props.onConfigured()
        } catch (err) {
            setError(errorMessage(err, t('settings.voice.credentials.saveFailed')))
        } finally {
            setBusy(false)
        }
    }

    const maxDurationStatus = status?.elevenLabsMaxDurationSeconds
    const maxDurationEditable = maxDurationStatus?.editable !== false

    const saveMaxDuration = async () => {
        const parsed = Number(maxDurationInput)
        if (
            !Number.isInteger(parsed)
            || parsed < VOICE_MAX_DURATION_MIN_SECONDS
            || parsed > VOICE_MAX_DURATION_MAX_SECONDS
        ) {
            setMaxDurationError(t('settings.voice.credentials.maxDuration.invalid', {
                min: String(VOICE_MAX_DURATION_MIN_SECONDS),
                max: String(VOICE_MAX_DURATION_MAX_SECONDS),
            }))
            return
        }
        setMaxDurationBusy(true)
        setMaxDurationError(null)
        setMaxDurationMessage(null)
        try {
            const next = await props.api.updateTranscriptionCredentials({ elevenLabsMaxDurationSeconds: parsed })
            setStatus(next)
            setMaxDurationInput(String(next.elevenLabsMaxDurationSeconds?.value ?? parsed))
            setMaxDurationMessage(t('settings.voice.credentials.maxDuration.saved'))
        } catch (err) {
            setMaxDurationError(errorMessage(err, t('settings.voice.credentials.saveFailed')))
        } finally {
            setMaxDurationBusy(false)
        }
    }

    const resetMaxDuration = async () => {
        setMaxDurationBusy(true)
        setMaxDurationError(null)
        setMaxDurationMessage(null)
        try {
            const next = await props.api.updateTranscriptionCredentials({ elevenLabsMaxDurationSeconds: null })
            setStatus(next)
            setMaxDurationInput(String(next.elevenLabsMaxDurationSeconds?.value ?? VOICE_MAX_DURATION_DEFAULT_SECONDS))
            setMaxDurationMessage(t('settings.voice.credentials.maxDuration.saved'))
        } catch (err) {
            setMaxDurationError(errorMessage(err, t('settings.voice.credentials.saveFailed')))
        } finally {
            setMaxDurationBusy(false)
        }
    }

    return (
        <div className="space-y-3 px-3 py-3">
            <p className="text-sm text-[var(--app-hint)]">
                {props.mode === 'assistant'
                    ? t('settings.voice.credentials.assistantHint')
                    : t('settings.voice.credentials.hint')}
            </p>
            <label className="block space-y-1">
                <span className="text-sm font-medium text-[var(--app-fg)]">{t('settings.voice.credentials.provider')}</span>
                <SelectControl
                    value={provider}
                    onChange={(event) => {
                        setProvider(event.target.value as CloudProvider)
                        setApiKey('')
                        setError(null)
                        setMessage(null)
                    }}
                    className="rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] py-1.5 pl-2 text-sm text-[var(--app-fg)]"
                >
                    {providers.map((option) => (
                        <option key={option} value={option}>{providerLabel(option, t)}</option>
                    ))}
                </SelectControl>
            </label>

            {selected?.configured ? (
                <p className="text-xs text-[var(--app-hint)]">
                    {t('settings.voice.credentials.configuredAs', {
                        source: selected.source === 'env'
                            ? t('settings.voice.credentials.source.env')
                            : t('settings.voice.credentials.source.settings'),
                        hint: selected.hint ?? '••••',
                    })}
                </p>
            ) : null}

            {provider === 'openai-compatible' ? (
                <>
                    <label className="block space-y-1">
                        <span className="text-sm font-medium text-[var(--app-fg)]">{t('settings.voice.credentials.baseUrl')}</span>
                        <input
                            type="url"
                            value={baseUrl}
                            onChange={(event) => setBaseUrl(event.target.value)}
                            placeholder="http://127.0.0.1:8000/v1"
                            disabled={busy || !baseUrlEditable}
                            className="w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5 text-sm text-[var(--app-fg)]"
                        />
                    </label>
                    <label className="block space-y-1">
                        <span className="text-sm font-medium text-[var(--app-fg)]">{t('settings.voice.credentials.model')}</span>
                        <input
                            type="text"
                            value={model}
                            onChange={(event) => setModel(event.target.value)}
                            placeholder="whisper-large-v3"
                            disabled={busy || !modelEditable}
                            className="w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5 text-sm text-[var(--app-fg)]"
                        />
                    </label>
                </>
            ) : null}

            <label className="block space-y-1">
                <span className="text-sm font-medium text-[var(--app-fg)]">{t('settings.voice.credentials.apiKey')}</span>
                <input
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder={selected?.configured ? t('settings.voice.credentials.apiKeyReplace') : t('settings.voice.credentials.apiKeyPlaceholder')}
                    disabled={busy || !apiKeyEditable}
                    className="w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5 text-sm text-[var(--app-fg)]"
                />
            </label>

            {selected?.editable === false ? (
                <p className="text-xs text-[var(--app-hint)]">{t('settings.voice.credentials.envLocked')}</p>
            ) : null}

            {provider === 'elevenlabs' ? (
                <div className="space-y-2 border-t border-[var(--app-divider)] pt-3">
                    <label className="block space-y-1">
                        <span className="text-sm font-medium text-[var(--app-fg)]">
                            {t('settings.voice.credentials.maxDuration.label')}
                        </span>
                        <input
                            type="number"
                            min={VOICE_MAX_DURATION_MIN_SECONDS}
                            max={VOICE_MAX_DURATION_MAX_SECONDS}
                            step={1}
                            value={maxDurationInput}
                            onChange={(event) => setMaxDurationInput(event.target.value)}
                            disabled={maxDurationBusy || !maxDurationEditable}
                            className="w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5 text-sm text-[var(--app-fg)]"
                        />
                    </label>
                    <p className="text-xs text-[var(--app-hint)]">
                        {t('settings.voice.credentials.maxDuration.hint', {
                            min: String(VOICE_MAX_DURATION_MIN_SECONDS),
                            max: String(VOICE_MAX_DURATION_MAX_SECONDS),
                        })}
                    </p>
                    {!maxDurationEditable ? (
                        <p className="text-xs text-[var(--app-hint)]">{t('settings.voice.credentials.envLocked')}</p>
                    ) : null}
                    {maxDurationError ? <p className="text-xs text-red-500">{maxDurationError}</p> : null}
                    {maxDurationMessage ? <p className="text-xs text-[var(--app-hint)]">{maxDurationMessage}</p> : null}
                    <div className="flex flex-wrap items-center justify-end gap-2">
                        <Button type="button" size="sm" disabled={maxDurationBusy || !maxDurationEditable} onClick={() => void saveMaxDuration()}>
                            {t('settings.voice.credentials.maxDuration.save')}
                        </Button>
                        {maxDurationStatus?.source === 'settings' ? (
                            <Button type="button" size="sm" variant="outline" disabled={maxDurationBusy} onClick={() => void resetMaxDuration()}>
                                {t('settings.voice.credentials.maxDuration.reset')}
                            </Button>
                        ) : null}
                    </div>
                </div>
            ) : null}

            {error ? <p className="text-xs text-red-500">{error}</p> : null}
            {message ? <p className="text-xs text-[var(--app-hint)]">{message}</p> : null}

            <div className="flex flex-wrap items-center justify-end gap-2">
                <Button type="button" size="sm" disabled={busy || selected?.editable === false} onClick={() => void save()}>
                    {t('settings.voice.credentials.save')}
                </Button>
                {(() => {
                    const canClearCompatible = provider === 'openai-compatible' && Boolean(
                        (baseUrlEditable && compatible?.baseUrl)
                        || (modelEditable && compatible?.model)
                        || (apiKeyEditable && compatible?.apiKey.configured)
                    )
                    const canClear = canClearCompatible || Boolean(
                        provider !== 'openai-compatible' && selected?.configured && selected.editable
                    )
                    return canClear ? (
                        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void clear()}>
                            {t('settings.voice.credentials.clear')}
                        </Button>
                    ) : null
                })()}
            </div>
        </div>
    )
}
