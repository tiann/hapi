import { useEffect, useMemo, useState } from 'react'
import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
    DEFAULT_USAGE_QUERY_TEMPLATE,
    DEFAULT_USAGE_QUERY_TEMPLATES,
    UsageQueryTemplateSchema,
    type UsageQueryAgent,
    type UsageQueryResult,
    type UsageQueryTemplate
} from '@hapi/protocol/usageQuery'
import { useAppContext } from '@/lib/app-context'
import { useTranslation } from '@/lib/use-translation'
import { useMachines } from '@/hooks/queries/useMachines'
import { useAgentAvailability } from '@/hooks/queries/useAgentAvailability'
import { queryKeys } from '@/lib/query-keys'
import { SettingsFieldLabel, SettingsPageContent, SettingsRow, SettingsSection, SettingsSwitch } from '@/components/settings/SettingsPrimitives'
import { SelectMenu } from '@/components/ui/select-menu'

const AGENTS: ReadonlyArray<{ value: UsageQueryAgent; labelKey: string }> = [
    { value: 'claude', labelKey: 'settings.usageQuery.agentClaude' },
    { value: 'codex', labelKey: 'settings.usageQuery.agentCodex' },
    { value: 'kimi', labelKey: 'settings.usageQuery.agentKimi' }
]

function parseTemplate(text: string): UsageQueryTemplate | null {
    try {
        const parsed: unknown = JSON.parse(text)
        const result = UsageQueryTemplateSchema.safeParse(parsed)
        return result.success ? result.data : null
    } catch {
        return null
    }
}

function formatResetTime(timestamp: number | null, now: number): string {
    if (timestamp === null) return '—'
    const totalMinutes = Math.max(0, Math.floor((timestamp - now) / 60_000))
    const days = Math.floor(totalMinutes / 1_440)
    const hours = Math.floor((totalMinutes % 1_440) / 60)
    const minutes = totalMinutes % 60
    if (days > 0) return `${days}d ${hours}h`
    if (hours > 0) return `${hours}h ${minutes}m`
    return `${minutes}m`
}

function UsageResultPreview(props: { result: UsageQueryResult | undefined; now: number; t: (key: string) => string }) {
    if (!props.result) return null

    const rows = [
        ['5H', props.result.fiveHour],
        ['7D', props.result.sevenDay]
    ] as const
    return (
        <div className="mt-3 rounded-lg bg-[var(--app-subtle-bg)] px-3 py-2 text-sm text-[var(--app-fg)]">
            <div className="mb-1 font-medium">{props.t('settings.usageQuery.testResult')}</div>
            <div className="grid grid-cols-[max-content_1fr_max-content] gap-x-3 gap-y-1 tabular-nums">
                {rows.map(([label, window]) => (
                    <div key={label} className="contents">
                        <span className="font-semibold">{label}</span>
                        <span className="text-right">{window ? `${Math.round(window.usedPercent)}%` : '—'}</span>
                        <span className="text-left text-[var(--app-hint)]">{window ? formatResetTime(window.resetsAt, props.now) : '—'}</span>
                    </div>
                ))}
            </div>
            {props.result.status === 'error' ? (
                <div role="alert" className="mt-2 text-red-500">
                    {props.result.error ?? props.t('settings.usageQuery.testFailed')}
                </div>
            ) : null}
        </div>
    )
}

type SaveInput = {
    machineId: string
    agent: UsageQueryAgent
    template: UsageQueryTemplate
    enabled: boolean
}

export default function SettingsUsageQueryPage() {
    const { t } = useTranslation()
    const { api } = useAppContext()
    const queryClient = useQueryClient()
    const {
        machines,
        isLoading: machinesLoading,
        error: machinesError,
        refetch: refetchMachines
    } = useMachines(api, true)
    const [machineId, setMachineId] = useState('')
    const [agent, setAgent] = useState<UsageQueryAgent>('claude')
    const [templateText, setTemplateText] = useState('')
    const [editorError, setEditorError] = useState<string | null>(null)
    const [now, setNow] = useState(() => Date.now())
    const agentAvailability = useAgentAvailability({ api, machineId })
    const availableAgents = useMemo(
        () => AGENTS.filter((item) => agentAvailability.agents.some((entry) => entry.agent === item.value && entry.available)),
        [agentAvailability.agents]
    )
    const selectedAgentAvailable = availableAgents.some((item) => item.value === agent)

    useEffect(() => {
        if (agentAvailability.isLoading || agentAvailability.error || availableAgents.length === 0 || selectedAgentAvailable) return
        setAgent(availableAgents[0]!.value)
    }, [agentAvailability.error, agentAvailability.isLoading, availableAgents, selectedAgentAvailable])

    useEffect(() => {
        if (machines.length === 0) {
            setMachineId('')
            return
        }
        if (!machineId || !machines.some((machine) => machine.id === machineId)) {
            setMachineId(machines[0].id)
        }
    }, [machineId, machines])

    const settingsQuery = useQuery({
        queryKey: machineId ? queryKeys.machineUsageQuery(machineId, agent) : ['machine-usage-query', 'none', agent],
        queryFn: async () => await api.getMachineUsageQuerySettings(machineId, agent),
        enabled: Boolean(
            machineId
            && !agentAvailability.isLoading
            && !agentAvailability.error
            && selectedAgentAvailable
        ),
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        retry: false
    })

    useEffect(() => {
        if (!settingsQuery.data) return
        setTemplateText(JSON.stringify(settingsQuery.data.template, null, 2))
        setEditorError(null)
    }, [settingsQuery.data])

    const currentTemplate = useMemo(() => parseTemplate(templateText), [templateText])
    const selectedTemplateId = currentTemplate?.id ?? settingsQuery.data?.templateId ?? DEFAULT_USAGE_QUERY_TEMPLATE.id
    const saveKey = ['usage-query-save', machineId, agent] as const
    const savePending = useIsMutating({ mutationKey: saveKey, exact: true }) > 0

    const testMutation = useMutation({
        mutationFn: async (template: UsageQueryTemplate) => await api.testMachineUsageQuery(machineId, agent, template)
    })
    const saveMutation = useMutation({
        mutationKey: saveKey,
        mutationFn: async (input: SaveInput) => await api.saveMachineUsageQuerySettings(input.machineId, input.agent, {
            enabled: input.enabled,
            templateId: input.template.id,
            template: input.template
        }),
        onSuccess: (data, input) => {
            queryClient.setQueryData(queryKeys.machineUsageQuery(input.machineId, input.agent), data)
            queryClient.removeQueries({ queryKey: queryKeys.machineUsageQueryResult(input.machineId, input.agent) })
        }
    })

    useEffect(() => {
        testMutation.reset()
        saveMutation.reset()
    }, [agent, machineId])

    const selectTemplate = (templateId: string) => {
        const template = DEFAULT_USAGE_QUERY_TEMPLATES.find((item) => item.id === templateId)
        if (!template) return
        setTemplateText(JSON.stringify(template, null, 2))
        setEditorError(null)
        testMutation.reset()
    }

    const validateEditor = (): UsageQueryTemplate | null => {
        const template = parseTemplate(templateText)
        if (!template) {
            setEditorError(t('settings.usageQuery.invalidTemplate'))
            return null
        }
        setEditorError(null)
        return template
    }

    const handleTest = () => {
        const template = validateEditor()
        if (!template || !machineId) return
        setNow(Date.now())
        testMutation.mutate(template)
    }

    const handleSave = () => {
        const template = validateEditor()
        if (!template || !machineId || savePending) return
        saveMutation.mutate({ machineId, agent, template, enabled: settingsQuery.data?.enabled ?? false })
    }

    return (
        <SettingsPageContent description={t('settings.usageQuery.description')}>
            <SettingsSection title={t('settings.usageQuery.target')}>
                <SettingsRow label={t('settings.usageQuery.machine')} contentClassName="flex-1">
                    {machinesError ? (
                        <div className="flex items-center justify-between gap-3 text-sm text-red-600">
                            <span>{machinesError}</span>
                            <button type="button" className="underline" onClick={() => void refetchMachines()}>{t('button.retry')}</button>
                        </div>
                    ) : machinesLoading ? <div className="text-sm text-[var(--app-hint)]">{t('settings.usageQuery.loadingMachines')}</div> : (
                        <SelectMenu
                            aria-label={t('settings.usageQuery.machine')}
                            value={machineId}
                            onChange={setMachineId}
                            options={machines.length === 0
                                ? [{ value: '', label: t('settings.usageQuery.noMachines') }]
                                : machines.map((machine) => ({
                                    value: machine.id,
                                    label: machine.metadata?.displayName || machine.metadata?.host || machine.id
                                }))}
                            disabled={machines.length === 0}
                            containerClassName="mt-1 w-full"
                        />
                    )}
                </SettingsRow>
                <SettingsRow label={t('settings.usageQuery.agent')} contentClassName="flex-1">
                    <SelectMenu
                        aria-label={t('settings.usageQuery.agent')}
                        value={agent}
                        onChange={(value) => setAgent(value as UsageQueryAgent)}
                        options={availableAgents.map((item) => ({ value: item.value, label: t(item.labelKey) }))}
                        placeholder={agentAvailability.isLoading
                            ? t('newSession.agentAvailabilityLoading')
                            : agentAvailability.error
                                ? t('newSession.agentAvailabilityFailed')
                                : t('newSession.noAvailableAgents')}
                        disabled={agentAvailability.isLoading || Boolean(agentAvailability.error) || availableAgents.length === 0}
                        containerClassName="mt-1 w-full"
                    />
                </SettingsRow>
                {agentAvailability.isLoading ? (
                    <div className="px-3 py-2 text-xs text-[var(--app-hint)]">{t('newSession.agentAvailabilityLoading')}</div>
                ) : agentAvailability.error ? (
                    <div className="flex items-center justify-between gap-3 px-3 py-2 text-xs text-red-600">
                        <span>{agentAvailability.upgradeRequired ? t('newSession.runnerUpgradeRequired') : t('newSession.agentAvailabilityFailed')}</span>
                        <button type="button" className="underline" onClick={agentAvailability.refetch}>{t('button.retry')}</button>
                    </div>
                ) : availableAgents.length === 0 ? (
                    <div className="px-3 py-2 text-xs text-red-600">{t('newSession.noAvailableAgents')}</div>
                ) : null}
            </SettingsSection>

            <SettingsSection title={t('settings.usageQuery.configuration')}>
                {settingsQuery.isLoading ? <SettingsRow label={t('settings.usageQuery.loading')} /> : null}
                {settingsQuery.error ? <SettingsRow label={t('settings.usageQuery.loadFailed')} description={settingsQuery.error instanceof Error ? settingsQuery.error.message : undefined} /> : null}
                {settingsQuery.data ? (
                    <>
                        <SettingsSwitch
                            label={t('settings.usageQuery.enabled')}
                            description={t('settings.usageQuery.enabledDescription')}
                            checked={settingsQuery.data.enabled}
                            onChange={(enabled) => {
                                const template = validateEditor()
                                if (!template || savePending) return
                                saveMutation.mutate({ machineId, agent, template, enabled })
                            }}
                        />
                        <SettingsRow label="{{baseUrl}}" description={t('settings.usageQuery.baseUrlDescription')} trailing={
                            <span className="text-sm text-[var(--app-hint)]">{settingsQuery.data.credentials.baseUrl.configured ? t('settings.usageQuery.configured') : t('settings.usageQuery.notConfigured')}</span>
                        } />
                        <SettingsRow label="{{apiKey}}" description={t('settings.usageQuery.apiKeyDescription')} trailing={
                            <span className="text-sm text-[var(--app-hint)]">{settingsQuery.data.credentials.apiKey.configured ? t('settings.usageQuery.configured') : t('settings.usageQuery.notConfigured')}</span>
                        } />
                        <div className="px-3 py-3">
                            <SettingsFieldLabel description={t('settings.usageQuery.templateDescription')}>{t('settings.usageQuery.template')}</SettingsFieldLabel>
                            <SelectMenu
                                aria-label={t('settings.usageQuery.template')}
                                value={selectedTemplateId}
                                onChange={selectTemplate}
                                options={DEFAULT_USAGE_QUERY_TEMPLATES.map((template) => ({ value: template.id, label: template.name }))}
                                disabled={savePending}
                                containerClassName="mb-2"
                            />
                            <textarea
                                aria-label={t('settings.usageQuery.templateEditor')}
                                value={templateText}
                                onChange={(event) => { setTemplateText(event.target.value); setEditorError(null) }}
                                spellCheck={false}
                                rows={18}
                                disabled={savePending}
                                className="w-full resize-y rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-2 py-2 font-mono text-xs leading-relaxed text-[var(--app-fg)] outline-none focus:border-[var(--app-link)] disabled:cursor-not-allowed disabled:opacity-50"
                            />
                            {editorError ? <div role="alert" className="mt-2 text-sm text-red-500">{editorError}</div> : null}
                            <div className="mt-3 flex flex-wrap justify-end gap-2">
                                <button type="button" onClick={handleTest} disabled={!machineId || testMutation.isPending} className="rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm font-medium text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)] disabled:opacity-50">
                                    {testMutation.isPending ? t('settings.usageQuery.testing') : t('settings.usageQuery.test')}
                                </button>
                                <button type="button" onClick={handleSave} disabled={!machineId || savePending} className="rounded-lg bg-[var(--app-button)] px-3 py-2 text-sm font-medium text-[var(--app-button-text)] hover:opacity-90 disabled:opacity-50">
                                    {savePending ? t('settings.usageQuery.saving') : t('settings.usageQuery.save')}
                                </button>
                            </div>
                            {testMutation.error ? <div role="alert" className="mt-2 text-sm text-red-500">{testMutation.error instanceof Error ? testMutation.error.message : t('settings.usageQuery.testFailed')}</div> : null}
                            {saveMutation.error ? <div role="alert" className="mt-2 text-sm text-red-500">{saveMutation.error instanceof Error ? saveMutation.error.message : t('settings.usageQuery.saveFailed')}</div> : null}
                            <UsageResultPreview result={testMutation.data} now={now} t={t} />
                        </div>
                    </>
                ) : null}
            </SettingsSection>

            <SettingsSection title={t('settings.usageQuery.documentation')}>
                <SettingsRow label={t('settings.usageQuery.hapiDocs')} trailing={<a className="text-sm text-[var(--app-link)] hover:underline" href="https://hapi.run/docs/guide/usage-query" target="_blank" rel="noopener noreferrer">{t('settings.usageQuery.open')}</a>} />
            </SettingsSection>
        </SettingsPageContent>
    )
}
