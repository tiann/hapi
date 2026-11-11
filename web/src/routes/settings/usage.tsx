import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { AgentQuotaAccount, AgentQuotaBucket, UsageSummaryBucket } from '@hapi/protocol/apiTypes'
import { SettingsPageContent, SettingsRow, SettingsSection } from '@/components/settings/SettingsPrimitives'
import { useAppContext } from '@/lib/app-context'
import { queryKeys } from '@/lib/query-keys'
import { useTranslation } from '@/lib/use-translation'

type UsageRange = '7d' | '30d' | 'all'

const AGENT_LABELS: Record<string, string> = {
    codex: 'Codex',
    agy: 'Antigravity (agy)',
    claude: 'Claude Code',
}

function formatTokens(value: number): string {
    if (value < 1000) return value.toLocaleString()
    if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}K`
    if (value < 1_000_000_000) return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}M`
    return `${(value / 1_000_000_000).toFixed(1)}B`
}

function formatResetTime(timestampMs: number): string {
    try {
        return new Intl.DateTimeFormat(undefined, {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        }).format(new Date(timestampMs))
    } catch {
        return new Date(timestampMs).toISOString()
    }
}

function quotaBarColorClass(remainingPercent: number): string {
    if (remainingPercent <= 5) return 'bg-red-500'
    if (remainingPercent <= 20) return 'bg-amber-500'
    return 'bg-[var(--app-link)]'
}

function QuotaBucketRow(props: { bucket: AgentQuotaBucket }) {
    const { t } = useTranslation()
    const { bucket } = props
    const remaining = Math.round(bucket.remainingPercent)
    const used = Math.round(bucket.usedPercent)
    return (
        <div className="space-y-1">
            <div className="flex items-center justify-between gap-2 text-xs">
                <span className="min-w-0 truncate font-medium text-[var(--app-fg)]">{bucket.label}</span>
                <span className="shrink-0 text-[var(--app-hint)]">
                    {t('settings.usage.quotas.remaining', {
                        remaining: String(remaining),
                        used: String(used)
                    })}
                </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-[var(--app-subtle-bg)]">
                <div
                    className={`h-full rounded-full transition-all ${quotaBarColorClass(bucket.remainingPercent)}`}
                    style={{ width: `${Math.max(0, Math.min(100, bucket.remainingPercent))}%` }}
                />
            </div>
            {bucket.resetsAt ? (
                <div className="text-[11px] text-[var(--app-hint)]">
                    {t('settings.usage.quotas.resetsAt', { time: formatResetTime(bucket.resetsAt) })}
                </div>
            ) : null}
        </div>
    )
}

function AccountQuotaCard(props: { account: AgentQuotaAccount; machineLabel?: string | null }) {
    const { t } = useTranslation()
    const { account, machineLabel } = props
    const agentTitle = AGENT_LABELS[account.agent] ?? account.agent
    const fallbackStatusNote = account.status === 'unauthenticated'
        ? t('settings.usage.quotas.status.unauthenticated')
        : account.status === 'custom_provider'
            ? t('settings.usage.quotas.status.custom_provider')
            : account.status === 'error'
                ? t('settings.usage.quotas.status.error')
                : null

    return (
        <div className="px-3 py-3 space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2 min-w-0">
                    <span className="text-sm font-semibold text-[var(--app-fg)]">{agentTitle}</span>
                    {machineLabel ? (
                        <span className="rounded bg-[var(--app-subtle-bg)] px-1.5 py-0.5 text-[11px] text-[var(--app-hint)]">
                            {machineLabel}
                        </span>
                    ) : null}
                    {account.planLabel ? (
                        <span className="rounded-full border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-2 py-0.5 text-[11px] font-medium text-[var(--app-fg)]">
                            {account.planLabel}
                        </span>
                    ) : null}
                    {account.creditsLabel ? (
                        <span className="rounded-full bg-[var(--app-subtle-bg)] px-2 py-0.5 text-[11px] text-[var(--app-link)]">
                            {account.creditsLabel}
                        </span>
                    ) : null}
                </div>
                {account.accountLabel ? (
                    <span className="truncate text-xs text-[var(--app-hint)]" title={account.accountLabel}>
                        {account.accountLabel}
                    </span>
                ) : null}
            </div>

            {account.buckets.length > 0 ? (
                <div className="space-y-2.5 pt-0.5">
                    {account.buckets.map((bucket) => (
                        <QuotaBucketRow key={bucket.id} bucket={bucket} />
                    ))}
                </div>
            ) : null}

            {account.note || fallbackStatusNote ? (
                <div className="text-xs text-[var(--app-hint)]">
                    {account.note ?? fallbackStatusNote}
                </div>
            ) : null}
        </div>
    )
}

function UsageBarList(props: { rows: UsageSummaryBucket[]; empty: string }) {
    const { t } = useTranslation()
    const max = props.rows[0]?.totalTokens ?? 0
    if (props.rows.length === 0) return <div className="px-3 py-4 text-sm text-[var(--app-hint)]">{props.empty}</div>
    return (
        <div className="divide-y divide-[var(--app-divider)]">
            {props.rows.slice(0, 8).map((row) => (
                <div key={row.key} className="px-3 py-3">
                    <div className="flex items-center justify-between gap-3 text-sm">
                        <span className="min-w-0 truncate font-medium text-[var(--app-fg)]">{row.key}</span>
                        <span className="shrink-0 text-[var(--app-hint)]">{formatTokens(row.totalTokens)}</span>
                    </div>
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--app-subtle-bg)]">
                        <div className="h-full rounded-full bg-[var(--app-link)]" style={{ width: `${max > 0 ? Math.max(2, (row.totalTokens / max) * 100) : 0}%` }} />
                    </div>
                    <div className="mt-1 text-xs text-[var(--app-hint)]">
                        {t('settings.usage.bucketDetails', {
                            requests: row.requests.toLocaleString(),
                            input: formatTokens(row.inputTokens),
                            output: formatTokens(row.outputTokens)
                        })}
                    </div>
                </div>
            ))}
        </div>
    )
}

export default function SettingsUsagePage() {
    const { api } = useAppContext()
    const { t } = useTranslation()
    const queryClient = useQueryClient()
    const [range, setRange] = useState<UsageRange>('7d')
    const [timeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')
    const [isRefreshingQuotas, setIsRefreshingQuotas] = useState(false)
    const [refreshQuotasError, setRefreshQuotasError] = useState<string | null>(null)

    const query = useQuery({
        queryKey: queryKeys.usageSummary(range, timeZone),
        queryFn: async () => {
            if (!api) throw new Error('API unavailable')
            return await api.getUsageSummary(range, timeZone)
        },
        enabled: Boolean(api),
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        retry: false
    })

    const quotasQuery = useQuery({
        queryKey: queryKeys.usageQuotas,
        queryFn: async () => {
            if (!api) throw new Error('API unavailable')
            setRefreshQuotasError(null)
            return await api.getUsageQuotas(false)
        },
        enabled: Boolean(api),
        staleTime: 60_000,
        refetchOnWindowFocus: false,
        retry: false
    })

    const handleRefreshQuotas = async () => {
        if (!api || isRefreshingQuotas) return
        setIsRefreshingQuotas(true)
        setRefreshQuotasError(null)
        try {
            const fresh = await api.getUsageQuotas(true)
            queryClient.setQueryData(queryKeys.usageQuotas, fresh)
        } catch (error) {
            setRefreshQuotasError(error instanceof Error ? error.message : String(error))
        } finally {
            setIsRefreshingQuotas(false)
        }
    }

    const quotaErrorMessage = refreshQuotasError
        ?? (quotasQuery.error ? (quotasQuery.error instanceof Error ? quotasQuery.error.message : String(quotasQuery.error)) : null)

    const visibleQuotaItems = useMemo(() => {
        const machines = quotasQuery.data?.machines ?? []
        const showMachineLabel = machines.length > 1
        const items: Array<
            | { kind: 'account'; key: string; account: AgentQuotaAccount; machineLabel: string | null }
            | { kind: 'machine-error'; key: string; machineLabel: string; error: string }
        > = []

        for (const machine of machines) {
            const label = machine.machineName || machine.machineId
            if (!machine.supported) {
                items.push({
                    kind: 'machine-error',
                    key: `${machine.machineId}:unsupported`,
                    machineLabel: label,
                    error: t('settings.usage.quotas.unsupportedRunner')
                })
                continue
            }
            if (machine.error && machine.accounts.length === 0) {
                items.push({
                    kind: 'machine-error',
                    key: `${machine.machineId}:error`,
                    machineLabel: label,
                    error: machine.error.includes('RPC method not available')
                        ? t('settings.usage.quotas.unsupportedRunner')
                        : machine.error
                })
                continue
            }
            for (const account of machine.accounts) {
                if (!account.available && account.status === 'unavailable') continue
                items.push({
                    kind: 'account',
                    key: `${machine.machineId}:${account.agent}`,
                    account,
                    machineLabel: showMachineLabel ? label : null
                })
            }
        }
        return items
    }, [quotasQuery.data?.machines, t])

    const maxDaily = useMemo(() => Math.max(...(query.data?.daily.map((row) => row.totalTokens) ?? [0]), 1), [query.data?.daily])
    const cacheHitRate = query.data && query.data.totals.inputTokens > 0
        ? `${((query.data.totals.cacheReadTokens / query.data.totals.inputTokens) * 100).toFixed(1)}%`
        : '0%'

    return (
        <SettingsPageContent description={t('settings.usage.description')}>
            <section>
                <div className="mb-2 flex items-center justify-between gap-2">
                    <h2 className="text-base font-semibold text-[var(--app-fg)]">
                        {t('settings.usage.quotas.title')}
                    </h2>
                    <button
                        type="button"
                        onClick={() => void handleRefreshQuotas()}
                        disabled={quotasQuery.isLoading || isRefreshingQuotas}
                        className="rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2.5 py-1 text-xs font-medium text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)] disabled:opacity-50"
                    >
                        {isRefreshingQuotas ? t('settings.usage.quotas.refreshing') : t('settings.usage.quotas.refresh')}
                    </button>
                </div>
                <div className="overflow-hidden rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] shadow-sm divide-y divide-[var(--app-divider)]">
                    {quotaErrorMessage ? (
                        <SettingsRow
                            label={t('settings.usage.quotas.status.error')}
                            description={quotaErrorMessage}
                        />
                    ) : null}
                    {quotasQuery.isLoading ? (
                        <SettingsRow label={t('settings.usage.quotas.loading')} />
                    ) : visibleQuotaItems.length === 0 ? (
                        quotaErrorMessage ? null : (
                            <div className="px-3 py-4 text-sm text-[var(--app-hint)]">
                                {t('settings.usage.quotas.empty')}
                            </div>
                        )
                    ) : (
                        visibleQuotaItems.map((item) => (
                            item.kind === 'machine-error' ? (
                                <SettingsRow
                                    key={item.key}
                                    label={item.machineLabel}
                                    description={item.error}
                                />
                            ) : (
                                <AccountQuotaCard
                                    key={item.key}
                                    account={item.account}
                                    machineLabel={item.machineLabel}
                                />
                            )
                        ))
                    )}
                </div>
            </section>

            <div className="inline-flex overflow-hidden rounded-lg border border-[var(--app-border)]" role="radiogroup" aria-label={t('settings.usage.range.label')}>
                {(['7d', '30d', 'all'] as const).map((option) => (
                    <button
                        key={option}
                        type="button"
                        role="radio"
                        aria-checked={range === option}
                        onClick={() => setRange(option)}
                        className={`border-r border-[var(--app-border)] px-3 py-2 text-sm font-medium transition-colors last:border-r-0 ${range === option ? 'bg-[var(--app-subtle-bg)] text-[var(--app-link)]' : 'text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]'}`}
                    >
                        {t(`settings.usage.range.${option}`)}
                    </button>
                ))}
            </div>

            {query.isLoading ? <SettingsSection><SettingsRow label={t('settings.usage.loading')} /></SettingsSection> : null}
            {query.error ? <SettingsSection><SettingsRow label={t('settings.usage.error')} description={query.error instanceof Error ? query.error.message : undefined} /></SettingsSection> : null}
            {query.data ? (
                <>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                        {[
                            ['settings.usage.total', query.data.totals.totalTokens],
                            ['settings.usage.uncached', query.data.totals.uncachedTokens],
                            ['settings.usage.input', query.data.totals.inputTokens],
                            ['settings.usage.output', query.data.totals.outputTokens],
                            ['settings.usage.cacheRead', query.data.totals.cacheReadTokens],
                            ['settings.usage.cacheCreation', query.data.totals.cacheCreationTokens],
                            ['settings.usage.cacheHitRate', cacheHitRate],
                            ['settings.usage.requests', query.data.totals.requests]
                        ].map(([label, value]) => (
                            <div key={label} className="rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-3 shadow-sm">
                                <div className="text-xs text-[var(--app-hint)]">{t(label as string)}</div>
                                <div className="mt-1 text-xl font-semibold text-[var(--app-fg)]">{typeof value === 'number' ? formatTokens(value) : value}</div>
                            </div>
                        ))}
                    </div>
                    <SettingsSection title={t('settings.usage.daily.title')}>
                        {query.data.daily.length === 0 ? <div className="px-3 py-4 text-sm text-[var(--app-hint)]">{t('settings.usage.empty')}</div> : (
                            <div className="space-y-3 px-3 py-4">
                                {query.data.daily.map((row) => (
                                    <div key={row.key} className="grid grid-cols-[5.5rem_1fr_auto] items-center gap-2 text-xs">
                                        <span className="text-[var(--app-hint)]">{row.key}</span>
                                        <div className="h-2 overflow-hidden rounded-full bg-[var(--app-subtle-bg)]"><div className="h-full rounded-full bg-[var(--app-link)]" style={{ width: `${Math.max(2, (row.totalTokens / maxDaily) * 100)}%` }} /></div>
                                        <span className="text-right font-medium text-[var(--app-fg)]">{formatTokens(row.totalTokens)}</span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </SettingsSection>
                    <div className="grid gap-5 md:grid-cols-2">
                        <SettingsSection title={t('settings.usage.agent.title')}>
                            <UsageBarList rows={query.data.byAgent} empty={t('settings.usage.empty')} />
                        </SettingsSection>
                        <SettingsSection title={t('settings.usage.model.title')}>
                            <UsageBarList rows={query.data.byModel} empty={t('settings.usage.empty')} />
                        </SettingsSection>
                    </div>
                    <div className="text-xs text-[var(--app-hint)]">
                        {t('settings.usage.sessions', { count: query.data.totals.sessions })}
                    </div>
                </>
            ) : null}
        </SettingsPageContent>
    )
}
