import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { UsageAgentStatus, UsageCost, UsageSummaryBucket } from '@hapi/protocol/apiTypes'
import { SettingsPageContent, SettingsRow, SettingsSection } from '@/components/settings/SettingsPrimitives'
import { useAppContext } from '@/lib/app-context'
import { queryKeys } from '@/lib/query-keys'
import { useTranslation } from '@/lib/use-translation'

type UsageRange = '7d' | '30d' | 'all'

function formatTokens(value: number): string {
    if (value < 1000) return value.toLocaleString()
    if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}K`
    if (value < 1_000_000_000) return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}M`
    return `${(value / 1_000_000_000).toFixed(1)}B`
}

export function formatCost(amount: number, currency: string, locale?: string): string {
    try {
        const base = new Intl.NumberFormat(locale, { style: 'currency', currency })
        // Costs below the currency's smallest unit (e.g. USD 0.004, or 0.4
        // for a zero-decimal currency such as JPY) would render as zero;
        // use significant digits so nonzero spend stays visible.
        const smallestUnit = 10 ** -(base.resolvedOptions().maximumFractionDigits ?? 2)
        const precision = amount > 0 && amount < smallestUnit
            ? { minimumSignificantDigits: 2, maximumSignificantDigits: 4 }
            : {}
        return new Intl.NumberFormat(locale, { style: 'currency', currency, ...precision }).format(amount)
    } catch {
        return `${amount.toFixed(4)} ${currency}`
    }
}

function formatCosts(costs: UsageCost[], locale: string): string {
    return costs.map((cost) => formatCost(cost.amount, cost.currency, locale)).join(' + ')
}

const AGENT_STATUS_ORDER: UsageAgentStatus[] = ['complete', 'context-only', 'cost-only', 'not-reported']

type AgentStatusStyle = Record<UsageAgentStatus, { className: string; label: string }>

function AgentAvailabilityList(props: { rows: Array<{ agent: string; status: UsageAgentStatus; sessions: number; costs: UsageCost[] }> }) {
    const { t, locale } = useTranslation()
    if (props.rows.length === 0) {
        return <div className="px-3 py-4 text-sm text-[var(--app-hint)]">{t('settings.usage.agents.empty')}</div>
    }
    const statusStyle: AgentStatusStyle = {
        'complete': { className: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400', label: t('settings.usage.agents.status.complete') },
        'context-only': { className: 'bg-amber-500/15 text-amber-600 dark:text-amber-400', label: t('settings.usage.agents.status.contextOnly') },
        'cost-only': { className: 'bg-sky-500/15 text-sky-600 dark:text-sky-400', label: t('settings.usage.agents.status.costOnly') },
        'not-reported': { className: 'bg-[var(--app-subtle-bg)] text-[var(--app-hint)]', label: t('settings.usage.agents.status.notReported') }
    }
    const rows = [...props.rows].sort((a, b) => {
        const rankDiff = AGENT_STATUS_ORDER.indexOf(a.status) - AGENT_STATUS_ORDER.indexOf(b.status)
        return rankDiff !== 0 ? rankDiff : a.agent.localeCompare(b.agent)
    })
    return (
        <div className="divide-y divide-[var(--app-divider)]">
            {rows.map((row) => (
                <div key={row.agent} className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm">
                    <span className="min-w-0 truncate font-medium text-[var(--app-fg)]">{row.agent}</span>
                    <span className="flex shrink-0 items-center gap-2">
                        {row.costs.length > 0 ? <span className="text-xs text-[var(--app-hint)]">{formatCosts(row.costs, locale)}</span> : null}
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusStyle[row.status].className}`}>
                            {statusStyle[row.status].label}
                        </span>
                    </span>
                </div>
            ))}
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
    const { t, locale } = useTranslation()
    const [range, setRange] = useState<UsageRange>('7d')
    const [timeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')
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
    const maxDaily = useMemo(() => Math.max(...(query.data?.daily.map((row) => row.totalTokens) ?? [0]), 1), [query.data?.daily])
    const cacheHitRate = query.data && query.data.totals.inputTokens > 0
        ? `${((query.data.totals.cacheReadTokens / query.data.totals.inputTokens) * 100).toFixed(1)}%`
        : '0%'

    return (
        <SettingsPageContent description={t('settings.usage.description')}>
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
                        {query.data.totals.costs.length > 0 ? (
                            <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-3 shadow-sm">
                                <div className="text-xs text-[var(--app-hint)]">{t('settings.usage.cost')}</div>
                                <div className="mt-1 text-xl font-semibold text-[var(--app-fg)]">{formatCosts(query.data.totals.costs, locale)}</div>
                            </div>
                        ) : null}
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
                    <SettingsSection title={t('settings.usage.agents.title')} description={t('settings.usage.agents.description')}>
                        <AgentAvailabilityList rows={query.data.agents} />
                    </SettingsSection>
                    <div className="text-xs text-[var(--app-hint)]">
                        {t('settings.usage.sessions', { count: query.data.totals.sessions })}
                    </div>
                </>
            ) : null}
        </SettingsPageContent>
    )
}
