import { useEffect, useState } from 'react'
import type { AgentQuotaBucket, AgentQuotasResponse } from '@hapi/protocol/apiTypes'
import * as Popover from '@radix-ui/react-popover'
import { useQuery } from '@tanstack/react-query'
import { useAppContext } from '@/lib/app-context'
import { queryKeys } from '@/lib/query-keys'
import { useTranslation } from '@/lib/use-translation'

const QUOTA_REFRESH_INTERVAL_MS = 120_000
const COUNTDOWN_TICK_MS = 30_000
const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

const WINDOW_SHORT_LABELS: Record<string, string> = {
    '5h': '5h',
    weekly: '7d'
}

/** The account-wide 5h and weekly windows for this agent, in that order. */
export function selectComposerQuotaBuckets(
    response: AgentQuotasResponse | undefined,
    agentFlavor: string | null | undefined
): AgentQuotaBucket[] {
    if (!response || !agentFlavor) return []
    const account = response.accounts.find((entry) => entry.agent === agentFlavor)
    if (!account || account.status !== 'ok') return []
    return Object.keys(WINDOW_SHORT_LABELS).flatMap((window) => {
        const bucket = account.buckets.find((entry) => !entry.group && entry.window === window)
        return bucket ? [bucket] : []
    })
}

/** The two most significant units of a duration: days+hours, hours+minutes, or minutes. */
function durationParts(ms: number): Array<{ unit: 'day' | 'hour' | 'minute'; value: number }> {
    const totalMinutes = Math.max(1, Math.ceil(ms / MINUTE_MS))
    const days = Math.floor(totalMinutes / (DAY_MS / MINUTE_MS))
    const hours = Math.floor((totalMinutes % (DAY_MS / MINUTE_MS)) / 60)
    const minutes = totalMinutes % 60
    const parts = days > 0
        ? [{ unit: 'day' as const, value: days }, { unit: 'hour' as const, value: hours }]
        : hours > 0
            ? [{ unit: 'hour' as const, value: hours }, { unit: 'minute' as const, value: minutes }]
            : [{ unit: 'minute' as const, value: minutes }]
    return parts.filter((part, index) => index === 0 || part.value > 0)
}

/** Compact countdown for the status chip, e.g. `2d14h`, `2h13m`, `35m`. */
export function formatCompactCountdown(ms: number): string {
    const suffix = { day: 'd', hour: 'h', minute: 'm' } as const
    return durationParts(ms).map((part) => `${part.value}${suffix[part.unit]}`).join('')
}

/** Localized countdown for the popover, e.g. `2天14小时`, `2 days 14 hours`. */
export function formatLongCountdown(ms: number, locale: string): string {
    const separator = locale.startsWith('zh') ? '' : ' '
    return durationParts(ms)
        .map((part) => new Intl.NumberFormat(locale, { style: 'unit', unit: part.unit, unitDisplay: 'long' }).format(part.value))
        .join(separator)
}

function quotaToneClass(remainingPercent: number): string {
    if (remainingPercent <= 5) return 'text-red-500'
    if (remainingPercent <= 20) return 'text-amber-500'
    return 'text-[var(--app-hint)]'
}

function quotaBarClass(remainingPercent: number): string {
    if (remainingPercent <= 5) return 'bg-red-500'
    if (remainingPercent <= 20) return 'bg-amber-500'
    return 'bg-[var(--app-link)]'
}

function formatResetTime(timestampMs: number): string {
    return new Intl.DateTimeFormat(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    }).format(new Date(timestampMs))
}

function useNow(intervalMs: number): number {
    const [now, setNow] = useState(() => Date.now())
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), intervalMs)
        return () => clearInterval(timer)
    }, [intervalMs])
    return now
}

/** Compact plan-quota readout (5h / 7d used + reset countdown) shown next to the context meter. */
export function AgentQuotaStatus(props: { machineId: string; agentFlavor: string | null | undefined }) {
    const { api } = useAppContext()
    const { t, locale } = useTranslation()
    const now = useNow(COUNTDOWN_TICK_MS)
    const query = useQuery({
        queryKey: queryKeys.machineAgentQuotas(props.machineId),
        queryFn: async () => await api.getMachineAgentQuotas(props.machineId),
        staleTime: 60_000,
        refetchInterval: QUOTA_REFRESH_INTERVAL_MS,
        retry: false
    })
    const buckets = selectComposerQuotaBuckets(query.data, props.agentFlavor)
    if (buckets.length === 0) return null

    const summary = buckets
        .map((bucket) => {
            const head = `${WINDOW_SHORT_LABELS[bucket.window ?? '']} ${Math.round(bucket.usedPercent)}%`
            return bucket.resetsAt && bucket.resetsAt > now
                ? `${head} (${formatCompactCountdown(bucket.resetsAt - now)})`
                : head
        })
        .join(' · ')
    const minRemaining = Math.min(...buckets.map((bucket) => bucket.remainingPercent))

    return (
        <Popover.Root>
            <Popover.Trigger asChild>
                <button
                    type="button"
                    aria-label={summary}
                    className={`min-w-0 cursor-pointer whitespace-nowrap rounded-sm bg-transparent p-0 text-[10px] leading-4 outline-none focus-visible:ring-1 focus-visible:ring-[var(--app-link)] ${quotaToneClass(minRemaining)}`}
                >
                    {/* On sm+ the context meter is an inline-flex whose baseline is its bar's bottom edge;
                        a zero-width bar of the same height gives this chip the same baseline. */}
                    <span className="sm:inline-flex sm:items-center">
                        <span aria-hidden="true" className="hidden h-1 w-0 sm:block" />
                        {summary}
                    </span>
                </button>
            </Popover.Trigger>
            <Popover.Portal>
                <Popover.Content
                    side="top"
                    align="start"
                    sideOffset={6}
                    collisionPadding={8}
                    className="z-50 w-[min(18rem,calc(100vw-1rem))] rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 shadow-lg"
                >
                    <div className="flex flex-col gap-3 text-xs leading-tight text-[var(--app-fg)]">
                        {buckets.map((bucket) => (
                            <div key={bucket.id} className="flex flex-col gap-1">
                                <div className="flex items-baseline justify-between gap-2">
                                    <span className="font-medium">{bucket.label}</span>
                                    <span className="text-[var(--app-hint)]">
                                        {t('settings.usage.quotas.used', { used: String(Math.round(bucket.usedPercent)) })}
                                    </span>
                                </div>
                                <div className="h-1.5 overflow-hidden rounded-full bg-[var(--app-subtle-bg)]">
                                    <div
                                        className={`h-full rounded-full ${quotaBarClass(bucket.remainingPercent)}`}
                                        style={{ width: `${Math.max(0, Math.min(100, bucket.usedPercent))}%` }}
                                    />
                                </div>
                                {bucket.resetsAt ? (
                                    <span className="text-[11px] text-[var(--app-hint)]">
                                        {bucket.resetsAt > now
                                            ? t('settings.usage.quotas.resetsIn', { time: formatLongCountdown(bucket.resetsAt - now, locale) })
                                            : t('settings.usage.quotas.resetsSoon')}
                                        {' · '}
                                        {formatResetTime(bucket.resetsAt)}
                                    </span>
                                ) : null}
                            </div>
                        ))}
                    </div>
                </Popover.Content>
            </Popover.Portal>
        </Popover.Root>
    )
}
