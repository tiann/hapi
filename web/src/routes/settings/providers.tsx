import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import {
    AGENT_PROVIDER_CAPABILITIES,
    formatProviderModelReference,
    parseProviderModelReference,
    type AgentProvider,
    type ProviderProfileInput,
    type ProviderProfileView,
    type ProviderProtocol
} from '@hapi/protocol'
import { SettingsChoiceGroup, SettingsPageContent, SettingsSection } from '@/components/settings/SettingsPrimitives'
import { useAppContext } from '@/lib/app-context'
import { useMachines } from '@/hooks/queries/useMachines'
import { useTranslation } from '@/lib/use-translation'

type FormState = {
    name: string
    protocol: ProviderProtocol
    baseUrl: string
    apiKey: string
    credentialType: 'api-key' | 'auth-token'
    defaultModel: string
    models: string
    enabled: boolean
}

const agentOptions: Array<{ value: AgentProvider; label: string }> = [
    { value: 'claude', label: 'Claude Code' },
    { value: 'codex', label: 'Codex' },
    { value: 'cursor', label: 'Cursor' },
    { value: 'grok', label: 'Grok Build' },
    { value: 'kimi', label: 'Kimi Code' },
    { value: 'opencode', label: 'OpenCode' },
    { value: 'pi', label: 'Pi' }
]

const protocolLabels: Record<ProviderProtocol, string> = {
    'anthropic-messages': 'Anthropic Messages',
    'openai-responses': 'OpenAI Responses',
    'openai-chat-completions': 'OpenAI Chat Completions',
    'gemini-generative-ai': 'Gemini Generative AI'
}

const emptyDefaults: Record<AgentProvider, string | null> = {
    claude: null,
    codex: null,
    cursor: null,
    grok: null,
    kimi: null,
    opencode: null,
    pi: null
}

function emptyForm(agent: AgentProvider): FormState {
    const capability = AGENT_PROVIDER_CAPABILITIES[agent]
    return {
        name: '',
        protocol: capability.protocols[0] ?? 'openai-chat-completions',
        baseUrl: '',
        apiKey: '',
        credentialType: capability.credentialTypes.includes('auth-token') ? 'api-key' : 'api-key',
        defaultModel: '',
        models: '',
        enabled: true
    }
}

function machineLabel(machine: { id: string; metadata?: { displayName?: string; host?: string } | null }): string {
    return machine.metadata?.displayName || machine.metadata?.host || machine.id.slice(0, 8)
}

function statusLabel(profile: ProviderProfileView, t: (key: string) => string): string {
    return t(`settings.providers.connection.${profile.health.status}`)
}

function modelReferences(value: string): Array<{ id: string; contextWindow: number }> {
    return value.split(/\r?\n|,/)
        .map((reference) => reference.trim())
        .filter(Boolean)
        .flatMap((reference) => {
            try {
                return [parseProviderModelReference(reference)]
            } catch {
                return []
            }
        })
}

function updateContextModelReference(models: string, id: string, supportsOneMillion: boolean): string {
    let found = false
    const updated = models.split(/\r?\n|,/)
        .map((reference) => reference.trim())
        .filter(Boolean)
        .map((reference) => {
            try {
                if (parseProviderModelReference(reference).id !== id) return reference
                found = true
                return supportsOneMillion ? `${id}[1M]` : id
            } catch {
                return reference
            }
        })
    if (supportsOneMillion && !found) updated.push(`${id}[1M]`)
    return updated.join('\n')
}

export default function SettingsProvidersPage() {
    const { api } = useAppContext()
    const { t } = useTranslation()
    const { machines, isLoading: machinesLoading } = useMachines(api, true)
    const [machineId, setMachineId] = useState('')
    const [agent, setAgent] = useState<AgentProvider>('claude')
    const [profiles, setProfiles] = useState<ProviderProfileView[]>([])
    const [defaults, setDefaults] = useState<Record<AgentProvider, string | null>>(emptyDefaults)
    const [loading, setLoading] = useState(false)
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [editingId, setEditingId] = useState<string | null>(null)
    const [form, setForm] = useState<FormState>(() => emptyForm('claude'))

    const capability = AGENT_PROVIDER_CAPABILITIES[agent]

    useEffect(() => {
        if (!machineId && machines[0]) setMachineId(machines[0].id)
        if (machineId && !machines.some((machine) => machine.id === machineId)) setMachineId(machines[0]?.id ?? '')
    }, [machineId, machines])

    const load = useCallback(async () => {
        if (!machineId) return
        setLoading(true)
        setError(null)
        try {
            const result = await api.listProviderProfiles(machineId)
            if (!result.success) throw new Error(result.error ?? 'Failed to load provider profiles')
            setProfiles(result.profiles ?? [])
            setDefaults(result.defaults ?? emptyDefaults)
        } catch (loadError) {
            setError(loadError instanceof Error ? loadError.message : 'Failed to load provider profiles')
        } finally {
            setLoading(false)
        }
    }, [api, machineId])

    useEffect(() => { void load() }, [load])

    const visibleProfiles = useMemo(() => profiles.filter((profile) => profile.agent === agent), [agent, profiles])
    const editableModels = useMemo(
        () => editingId ? visibleProfiles.find((profile) => profile.id === editingId)?.models ?? [] : [],
        [editingId, visibleProfiles]
    )
    const contextModelIds = useMemo(() => Array.from(new Set([
        ...editableModels.map((model) => model.id),
        ...modelReferences(form.models).map((model) => model.id)
    ])).sort((left, right) => left.localeCompare(right)), [editableModels, form.models])
    const oneMillionContextModelIds = useMemo(() => new Set(
        modelReferences(form.models)
            .filter((model) => model.contextWindow === 1_000_000)
            .map((model) => model.id)
    ), [form.models])
    const defaultModelReferences = useMemo(() => Array.from(new Set(editableModels.flatMap((model) => (
        model.contextWindow === 1_000_000 ? [model.id, formatProviderModelReference(model)] : [model.id]
    )))), [editableModels])

    const resetForm = useCallback(() => {
        setEditingId(null)
        setForm(emptyForm(agent))
    }, [agent])

    const chooseAgent = (nextAgent: AgentProvider) => {
        setAgent(nextAgent)
        setEditingId(null)
        setForm(emptyForm(nextAgent))
    }

    const editProfile = (profile: ProviderProfileView) => {
        setEditingId(profile.id)
        setForm({
            name: profile.name,
            protocol: profile.protocol,
            baseUrl: profile.baseUrl ?? '',
            apiKey: '',
            credentialType: profile.credentialType,
            defaultModel: profile.defaultModel ?? '',
            models: profile.models.filter((model) => model.source === 'custom').map(formatProviderModelReference).join('\n'),
            enabled: profile.enabled
        })
    }

    const submit = async (event: FormEvent) => {
        event.preventDefault()
        if (!machineId || !capability.managed || !form.name.trim() || (!editingId && !form.apiKey)) return
        setSaving(true)
        setError(null)
        try {
            const models = form.models.split(/\r?\n|,/).map((value) => value.trim()).filter(Boolean)
            const common = {
                name: form.name.trim(),
                agent,
                protocol: form.protocol,
                ...(editingId ? { baseUrl: form.baseUrl.trim() || null } : form.baseUrl.trim() ? { baseUrl: form.baseUrl.trim() } : {}),
                credentialType: form.credentialType,
                ...(editingId ? { defaultModel: form.defaultModel.trim() || null } : form.defaultModel.trim() ? { defaultModel: form.defaultModel.trim() } : {}),
                ...(editingId ? { models } : { models }),
                enabled: form.enabled
            }
            const result = editingId
                ? await api.updateProviderProfile(machineId, editingId, { ...common, ...(form.apiKey ? { apiKey: form.apiKey } : {}) })
                : await api.createProviderProfile(machineId, { ...common, apiKey: form.apiKey } as ProviderProfileInput)
            if (!result.success) throw new Error(result.error ?? 'Failed to save provider profile')
            resetForm()
            await load()
        } catch (saveError) {
            setError(saveError instanceof Error ? saveError.message : 'Failed to save provider profile')
        } finally {
            setSaving(false)
        }
    }

    const setDefault = async (id: string | null) => {
        if (!machineId || !capability.managed) return
        setSaving(true)
        setError(null)
        try {
            const result = await api.setDefaultProvider(machineId, agent, id)
            if (!result.success) throw new Error(result.error ?? 'Failed to change default provider')
            await load()
        } catch (defaultError) {
            setError(defaultError instanceof Error ? defaultError.message : 'Failed to change default provider')
        } finally {
            setSaving(false)
        }
    }

    const checkHealth = async (profile: ProviderProfileView) => {
        if (!machineId) return
        setSaving(true)
        setError(null)
        try {
            const result = await api.checkProviderHealth(machineId, profile.id, true)
            if (!result.success) throw new Error(result.error ?? 'Provider connection failed')
            await load()
        } catch (healthError) {
            setError(healthError instanceof Error ? healthError.message : 'Provider connection failed')
            await load()
        } finally {
            setSaving(false)
        }
    }

    return (
        <SettingsPageContent title={t('settings.providers.title')} description={t('settings.providers.description')}>
            <SettingsSection title={t('settings.providers.machine')}>
                <div className="p-3">
                    <select value={machineId} onChange={(event) => { setMachineId(event.target.value); resetForm() }} disabled={machinesLoading} className="h-10 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 text-[var(--app-fg)]">
                        {machines.map((machine) => <option key={machine.id} value={machine.id}>{machineLabel(machine)}</option>)}
                    </select>
                </div>
            </SettingsSection>

            <SettingsSection>
                <SettingsChoiceGroup label={t('settings.providers.agent')} value={agent} options={agentOptions} onChange={chooseAgent} />
            </SettingsSection>

            <SettingsSection title={t('settings.providers.profiles')}>
                <button type="button" disabled={saving || !capability.managed} onClick={() => void setDefault(null)} className="flex w-full items-center justify-between px-3 py-3 text-left hover:bg-[var(--app-subtle-bg)] disabled:opacity-50">
                    <span>
                        <span className="block text-[var(--app-fg)]">{t('settings.providers.system')}</span>
                        <span className="block text-xs text-[var(--app-hint)]">{t('settings.providers.systemDescription')}</span>
                    </span>
                    {defaults[agent] === null ? <span className="text-sm font-medium text-[var(--app-link)]">{t('settings.providers.default')}</span> : null}
                </button>
                {!capability.managed ? <div className="px-3 pb-3 text-sm text-[var(--app-hint)]">{t('settings.providers.nativeOnly')}</div> : null}
                {visibleProfiles.map((profile) => (
                    <div key={profile.id} className="flex items-start gap-3 border-t border-[var(--app-divider)] px-3 py-3">
                        <button type="button" onClick={() => editProfile(profile)} className="min-w-0 flex-1 text-left">
                            <span className="block truncate text-[var(--app-fg)]">{profile.name}</span>
                            <span className="block truncate text-xs text-[var(--app-hint)]">{protocolLabels[profile.protocol]} · {profile.baseUrl || t('settings.providers.official')} · {profile.secretHint ?? '••••'} · {statusLabel(profile, t)}</span>
                            <span className="mt-1 block truncate text-xs text-[var(--app-hint)]">{profile.models.map(formatProviderModelReference).join(', ') || t('settings.providers.noModels')}</span>
                        </button>
                        <div className="flex shrink-0 flex-col gap-1">
                            <button type="button" disabled={saving} onClick={() => void checkHealth(profile)} className="rounded border border-[var(--app-border)] px-2 py-1 text-xs disabled:opacity-50">{t('settings.providers.test')}</button>
                            {defaults[agent] === profile.id ? <span className="text-xs font-medium text-[var(--app-link)]">{t('settings.providers.default')}</span> : <button type="button" disabled={saving || !profile.enabled} onClick={() => void setDefault(profile.id)} className="rounded border border-[var(--app-border)] px-2 py-1 text-xs disabled:opacity-50">{t('settings.providers.setDefault')}</button>}
                        </div>
                    </div>
                ))}
                {!loading && capability.managed && visibleProfiles.length === 0 ? <div className="px-3 py-4 text-sm text-[var(--app-hint)]">{t('settings.providers.empty')}</div> : null}
            </SettingsSection>

            {capability.managed ? <SettingsSection title={editingId ? t('settings.providers.edit') : t('settings.providers.add')}>
                <form onSubmit={submit} className="space-y-3 p-3">
                    <input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder={t('settings.providers.name')} className="h-10 w-full rounded-lg border border-[var(--app-border)] bg-transparent px-3" />
                    <select aria-label={t('settings.providers.protocol')} value={form.protocol} onChange={(event) => setForm({ ...form, protocol: event.target.value as ProviderProtocol })} className="h-10 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3">
                        {capability.protocols.map((protocol) => <option key={protocol} value={protocol}>{protocolLabels[protocol]}</option>)}
                    </select>
                    <input value={form.baseUrl} onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} placeholder={t('settings.providers.baseUrl')} type="url" className="h-10 w-full rounded-lg border border-[var(--app-border)] bg-transparent px-3" />
                    <input required={!editingId} value={form.apiKey} onChange={(event) => setForm({ ...form, apiKey: event.target.value })} placeholder={editingId ? t('settings.providers.secretUnchanged') : t('settings.providers.apiKey')} type="password" autoComplete="new-password" className="h-10 w-full rounded-lg border border-[var(--app-border)] bg-transparent px-3" />
                    {capability.credentialTypes.length > 1 ? <select value={form.credentialType} onChange={(event) => setForm({ ...form, credentialType: event.target.value as FormState['credentialType'] })} className="h-10 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3"><option value="api-key">API key</option><option value="auth-token">Auth token</option></select> : null}
                    <input list="provider-models" value={form.defaultModel} onChange={(event) => setForm({ ...form, defaultModel: event.target.value })} placeholder={t('settings.providers.defaultModel')} className="h-10 w-full rounded-lg border border-[var(--app-border)] bg-transparent px-3" />
                    <datalist id="provider-models">{defaultModelReferences.map((model) => <option key={model} value={model} />)}</datalist>
                    <textarea value={form.models} onChange={(event) => setForm({ ...form, models: event.target.value })} placeholder={t('settings.providers.customModels')} rows={3} className="w-full rounded-lg border border-[var(--app-border)] bg-transparent px-3 py-2 text-sm" />
                    {contextModelIds.length > 0 ? <fieldset className="space-y-2 rounded-lg border border-[var(--app-border)] p-3">
                        <legend className="px-1 text-sm font-medium">{t('settings.providers.context1m')}</legend>
                        <div className="text-xs text-[var(--app-hint)]">{t('settings.providers.context1mHint')}</div>
                        <div className="flex flex-wrap gap-x-4 gap-y-2">
                            {contextModelIds.map((modelId) => <label key={modelId} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={oneMillionContextModelIds.has(modelId)} onChange={(event) => setForm((current) => ({ ...current, models: updateContextModelReference(current.models, modelId, event.target.checked) }))} />{modelId}[1M]</label>)}
                        </div>
                    </fieldset> : null}
                    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} />{t('settings.providers.enabled')}</label>
                    <div className="flex justify-end gap-2">
                        {editingId ? <button type="button" onClick={resetForm} className="rounded-lg px-3 py-2 text-sm text-[var(--app-hint)]">{t('common.cancel')}</button> : null}
                        <button type="submit" disabled={saving || !machineId} className="rounded-lg bg-[var(--app-button)] px-4 py-2 text-sm font-medium text-[var(--app-button-text)] disabled:opacity-50">{saving ? t('loading') : t('common.save')}</button>
                    </div>
                </form>
            </SettingsSection> : null}
            {error ? <div className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-600">{error}</div> : null}
        </SettingsPageContent>
    )
}
