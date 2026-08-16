import { useRef } from 'react'
import type { TextMessagePartComponent } from '@assistant-ui/react'
import { splitNotifySummary, stripNotifySummaryFooter, type NotifySummary } from '@hapi/protocol/messages'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { MarkdownText } from '@/components/assistant-ui/markdown-text'
import { CheckIcon } from '@/components/icons'
import { useSessionSummaryInChat } from '@/hooks/useSessionSummaryInChat'
import { useTranslation } from '@/lib/use-translation'

type SummaryStatusPresentation = {
    labelKey: string
    marker: 'check' | 'dot'
    markerClassName: string
}

const SUMMARY_STATUS_PRESENTATIONS: Record<string, SummaryStatusPresentation> = {
    done: { labelKey: 'session.summary.status.done', marker: 'check', markerClassName: 'text-[var(--app-badge-success-text)]' },
    blocked: { labelKey: 'session.summary.status.blocked', marker: 'dot', markerClassName: 'bg-[var(--app-badge-warning-text)]' },
    needs_review: { labelKey: 'session.summary.status.needsReview', marker: 'dot', markerClassName: 'bg-[var(--app-badge-warning-text)]' },
    needs_decision: { labelKey: 'session.summary.status.needsDecision', marker: 'dot', markerClassName: 'bg-[var(--app-badge-warning-text)]' },
    failed: { labelKey: 'session.summary.status.failed', marker: 'dot', markerClassName: 'bg-[var(--app-badge-error-text)]' },
    stalled: { labelKey: 'session.summary.status.stalled', marker: 'dot', markerClassName: 'bg-[var(--app-badge-warning-text)]' }
}

function normalizeStatus(status: string | undefined): string {
    return status?.trim().toLowerCase() ?? ''
}

function humanizeStatus(status: string): string {
    return status
        .replaceAll('_', ' ')
        .replace(/\b\w/g, (character) => character.toUpperCase())
}

function SummaryStatusIndicator({ summary }: { summary: NotifySummary }) {
    const { t } = useTranslation()
    const normalizedStatus = normalizeStatus(summary.status)
    const presentation = Object.hasOwn(SUMMARY_STATUS_PRESENTATIONS, normalizedStatus)
        ? SUMMARY_STATUS_PRESENTATIONS[normalizedStatus]
        : undefined
    const statusLabel = presentation
        ? t(presentation.labelKey)
        : normalizedStatus
            ? humanizeStatus(normalizedStatus)
            : t('session.summary.label')

    return (
        <span
            data-testid="notify-summary-status"
            aria-label={statusLabel}
            className={`inline-flex shrink-0 items-center text-xs leading-5 text-[var(--app-hint)] ${presentation?.marker === 'check' ? 'h-5 w-4 justify-center' : 'gap-1.5'}`}
        >
            {presentation?.marker === 'check' ? (
                <span aria-hidden="true">
                    <CheckIcon className={`block h-4 w-4 ${presentation.markerClassName}`} />
                </span>
            ) : (
                <>
                    <span
                        aria-hidden="true"
                        className={`h-1.5 w-1.5 -translate-y-px rounded-full ${presentation?.markerClassName ?? 'bg-[var(--app-hint)]'}`}
                    />
                    <span>{statusLabel}</span>
                </>
            )}
        </span>
    )
}

export function NotifySummaryFooter({ summary }: { summary: NotifySummary }) {
    const { t } = useTranslation()
    const summaryText = summary.summary?.trim() ?? ''
    const actionText = summary.action?.trim() ?? ''

    if (!summaryText && !actionText && !summary.status?.trim()) return null

    return (
        <div
            role="status"
            aria-label={t('session.summary.ariaLabel')}
            data-testid="notify-summary-footer"
            className="mt-2 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2 gap-y-0.5 border-t border-[var(--app-divider)] pt-2"
        >
            <SummaryStatusIndicator summary={summary} />
            {summaryText ? (
                <span className="min-w-0 break-words text-sm leading-5 text-[var(--app-fg)]">
                    {summaryText}
                </span>
            ) : null}
            {actionText && actionText !== summaryText ? (
                <>
                    <span className="col-start-1 inline-flex h-5 w-4 items-center justify-center text-xs leading-none text-[var(--app-hint)]">
                        <span aria-hidden="true">→</span>
                    </span>
                    <span className="col-start-2 min-w-0 break-words text-xs leading-5 text-[var(--app-hint)]">
                        {actionText}
                    </span>
                </>
            ) : null}
        </div>
    )
}

/** Render the machine footer as a compact row when display is on; otherwise strip it. */
export const NotifySummaryText: TextMessagePartComponent = ({ text, status }) => {
    const showInChat = useSessionSummaryInChat()
    const previousTextRef = useRef(text)
    const runStartedWithRunningRef = useRef(status.type === 'running')
    const hasTextChangedDuringRunRef = useRef(false)

    // The runtime keeps already-materialized history complete while a session
    // is being resumed or a new turn is waiting for its first assistant block.
    // Once this part is actually running, keep assistant-ui's typewriter
    // enabled from its first paint. A status-only complete -> running change
    // with unchanged text is still treated as hydration, not new output.
    if (status.type !== 'running') {
        runStartedWithRunningRef.current = false
        hasTextChangedDuringRunRef.current = false
    } else if (
        text !== previousTextRef.current
    ) {
        hasTextChangedDuringRunRef.current = true
    }
    const smooth = status.type === 'running'
        && (runStartedWithRunningRef.current || hasTextChangedDuringRunRef.current)

    previousTextRef.current = text

    if (!showInChat) {
        const stripped = stripNotifySummaryFooter(text)
        if (!stripped) return null
        if (stripped === text) return <MarkdownText smooth={smooth} />
        return <MarkdownRenderer content={stripped} />
    }

    if (status.type !== 'complete') return <MarkdownText smooth={smooth} />

    const display = splitNotifySummary(text)
    if (!display) return <MarkdownText smooth={smooth} />

    const hasDisplayableSummary = Boolean(
        display.summary.summary?.trim()
        || display.summary.action?.trim()
        || display.summary.status?.trim()
    )
    if (!hasDisplayableSummary) {
        if (!display.visibleText) return null
        return <MarkdownRenderer content={display.visibleText} />
    }

    return (
        <>
            {display.visibleText ? <MarkdownRenderer content={display.visibleText} /> : null}
            <NotifySummaryFooter summary={display.summary} />
        </>
    )
}
