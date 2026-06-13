import type { PendingRequest, SessionSummary } from '@/types/api'
import type { SessionAttention } from '@/lib/sessionAttention'
import { getSessionAttentionLabelKey } from '@/lib/sessionAttention'
import { useTranslation } from '@/lib/use-translation'
import { HoverTooltip } from '@/components/HoverTooltip'

const ATTENTION_DOT_CLASS: Record<SessionAttention['kind'], string> = {
    permission: 'bg-amber-500 animate-pulse',
    input: 'bg-blue-500',
    background: 'bg-blue-400',
    unread: 'bg-[var(--app-link)]'
}

/**
 * Visible attention dot + hover tooltip explaining the indicator.
 *
 * The tooltip body composes from `summary.pendingRequests` (capped oldest-first;
 * see `PENDING_REQUEST_SUMMARY_CAP` in `@hapi/protocol`) for permission / input
 * attention; from counts and timestamps for background / unread.
 */
export function SessionAttentionIndicator(props: {
    attention: SessionAttention
    summary: SessionSummary
    label: string
}) {
    const { t } = useTranslation()
    const dot = (
        <span
            className={`inline-flex h-2 w-2 shrink-0 rounded-full ${ATTENTION_DOT_CLASS[props.attention.kind]}`}
        />
    )

    return (
        <HoverTooltip
            label={props.label}
            target={dot}
            side="bottom"
            align="start"
            className="shrink-0"
        >
            <AttentionTooltipBody
                attention={props.attention}
                summary={props.summary}
                label={props.label}
                t={t}
            />
        </HoverTooltip>
    )
}

function AttentionTooltipBody(props: {
    attention: SessionAttention
    summary: SessionSummary
    label: string
    t: (key: string, params?: Record<string, string | number>) => string
}) {
    const { attention, summary, label, t } = props
    return (
        <span className="block">
            <span className="block font-medium">{label}</span>
            <AttentionTooltipDetail attention={attention} summary={summary} t={t} />
        </span>
    )
}

function AttentionTooltipDetail(props: {
    attention: SessionAttention
    summary: SessionSummary
    t: (key: string, params?: Record<string, string | number>) => string
}) {
    const { attention, summary, t } = props

    if (attention.kind === 'permission' || attention.kind === 'input') {
        const wantedKind = attention.kind
        const items = (summary.pendingRequests ?? [])
            .filter((req): req is PendingRequest => req.kind === wantedKind)
        if (items.length === 0) {
            return null
        }
        // Overflow is only knowable per-kind when all pending requests in the
        // session share that kind — otherwise `pendingRequestsCount` mixes the
        // counts of both kinds. Suppress the "+N more" hint in the mixed case
        // rather than report a wrong number.
        const kinds = summary.pendingRequestKinds ?? []
        const onlyThisKind = kinds.length === 1 && kinds[0] === wantedKind
        const overflow = onlyThisKind
            ? Math.max(0, (summary.pendingRequestsCount ?? items.length) - items.length)
            : 0
        const bodyKey = wantedKind === 'permission'
            ? 'session.tooltip.permission.body'
            : 'session.tooltip.input.body'
        return (
            <span className="block mt-1">
                <span className="block text-[var(--app-hint)]">{t(bodyKey)}</span>
                <ul className="mt-0.5 list-disc pl-4">
                    {items.map(req => (
                        <li key={req.id} className="font-mono text-[11px] break-all">
                            {req.tool}
                        </li>
                    ))}
                </ul>
                {overflow > 0 ? (
                    <span className="mt-0.5 block text-[var(--app-hint)]">
                        {t('session.tooltip.moreCount', { count: overflow })}
                    </span>
                ) : null}
            </span>
        )
    }

    if (attention.kind === 'background') {
        const count = summary.backgroundTaskCount ?? 0
        if (count <= 0) return null
        const key = count === 1
            ? 'session.tooltip.background.count.one'
            : 'session.tooltip.background.count.other'
        return (
            <span className="mt-1 block text-[var(--app-hint)]">
                {t(key, { count })}
            </span>
        )
    }

    // 'unread' deliberately has no body: the relative-time pill is already
    // rendered in the session row, so a tooltip body would just duplicate it.
    return null
}

export function getAttentionLabel(
    attention: SessionAttention,
    t: (key: string) => string
): string {
    return t(getSessionAttentionLabelKey(attention))
}
