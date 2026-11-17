import { useMemo, useState } from 'react'
import { resolveSessionParentLink, type SessionLinkKind } from '@hapi/protocol'
import type { Session, SessionSummary } from '@/types/api'
import { SessionLinkAnchor } from '@/components/SessionLinkAnchor'
import { getSessionTitle } from '@/lib/sessionTitle'
import { useTranslation } from '@/lib/use-translation'

const INITIAL_CHILD_PILL_LIMIT = 4

type LinkStatusTone = 'working' | 'pending' | 'active' | 'inactive'

function classifySummaryTone(summary: SessionSummary | undefined): LinkStatusTone {
    if (!summary) return 'inactive'
    if ((summary.active && summary.thinking) || summary.attachedJob?.status === 'running') {
        return 'working'
    }
    if (summary.active && (summary.pendingRequestsCount ?? 0) > 0) {
        return 'pending'
    }
    return summary.active ? 'active' : 'inactive'
}

function tonePriority(tone: LinkStatusTone): number {
    switch (tone) {
        case 'pending': return 0
        case 'working': return 1
        case 'active': return 2
        case 'inactive': return 3
    }
}

function StatusDot({ tone }: { tone: LinkStatusTone }) {
    if (tone === 'working') {
        return <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--app-badge-success-text)] animate-pulse" aria-hidden="true" />
    }
    if (tone === 'pending') {
        return <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--app-badge-warning-text)]" aria-hidden="true" />
    }
    if (tone === 'active') {
        return <span className="h-1.5 w-1.5 shrink-0 rounded-full border border-[var(--app-badge-success-text)]" aria-hidden="true" />
    }
    return <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--app-hint)] opacity-50" aria-hidden="true" />
}

function KindTag({ kind }: { kind: SessionLinkKind }) {
    const { t } = useTranslation()
    return (
        <span className="rounded bg-[var(--app-bg)]/80 px-1 py-px text-[10px] leading-none text-[var(--app-hint)]">
            {t(`sessions.lineage.kind.${kind}`)}
        </span>
    )
}

export function SessionLineageBar(props: {
    session: Session
    sessions: readonly SessionSummary[]
}) {
    const { t } = useTranslation()
    const [showAllChildren, setShowAllChildren] = useState(false)

    const parentLink = resolveSessionParentLink(props.session.metadata, props.session.id)
    const byId = useMemo(() => {
        const map = new Map<string, SessionSummary>()
        for (const s of props.sessions) map.set(s.id, s)
        return map
    }, [props.sessions])

    const children = useMemo(() => {
        const matched = props.sessions.filter(
            (candidate) => candidate.id !== props.session.id
                && candidate.metadata?.parentLink?.parentSessionId === props.session.id
        )
        matched.sort((a, b) => {
            const pDiff = tonePriority(classifySummaryTone(a)) - tonePriority(classifySummaryTone(b))
            if (pDiff !== 0) return pDiff
            return b.updatedAt - a.updatedAt
        })
        return matched
    }, [props.sessions, props.session.id])

    if (!parentLink && children.length === 0) {
        return null
    }

    const parentSummary = parentLink ? byId.get(parentLink.parentSessionId) : undefined
    const parentTitle = parentLink
        ? (parentSummary ? getSessionTitle(parentSummary) : parentLink.parentSessionId.slice(0, 8))
        : null
    const parentTone = classifySummaryTone(parentSummary)

    const visibleChildren = showAllChildren ? children : children.slice(0, INITIAL_CHILD_PILL_LIMIT)
    const hiddenChildCount = Math.max(0, children.length - visibleChildren.length)

    return (
        <div
            data-testid="session-lineage-bar"
            className="border-b border-[var(--app-divider)] bg-[var(--app-subtle-bg)]/40 px-3 py-2 text-xs text-[var(--app-hint)]"
        >
            <div className="mx-auto flex w-full max-w-content flex-col gap-1.5">
                {parentLink?.kind === 'branch' ? (
                    <div>
                        <div className="flex flex-wrap items-center gap-1.5">
                            <StatusDot tone={parentTone} />
                            <SessionLinkAnchor
                                sessionId={parentLink.parentSessionId}
                                className="font-medium text-[var(--app-fg)] underline hover:text-[var(--app-link)]"
                            >
                                {t('branch.source')}
                            </SessionLinkAnchor>
                            {parentSummary ? (
                                <span className="truncate text-[var(--app-hint)]">({parentTitle})</span>
                            ) : null}
                            <span>{'· '}{t('branch.filesNotice')}</span>
                        </div>
                        {props.session.metadata?.conversationBranch?.state !== 'started' ? (
                            <p role="status" className="mt-1">{t('branch.uncertain')}</p>
                        ) : null}
                    </div>
                ) : parentLink ? (
                    <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--app-hint)]">
                            {t('sessions.lineage.parentPrefix')}
                        </span>
                        <SessionLinkAnchor
                            sessionId={parentLink.parentSessionId}
                            className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-[var(--app-border)] bg-[var(--app-bg)] px-2.5 py-0.5 text-xs font-medium text-[var(--app-fg)] transition-colors hover:border-[var(--app-link)] hover:text-[var(--app-link)]"
                        >
                            <StatusDot tone={parentTone} />
                            <span aria-hidden="true">↑</span>
                            <span className="truncate max-w-56">{parentTitle}</span>
                            <KindTag kind={parentLink.kind} />
                        </SessionLinkAnchor>
                    </div>
                ) : null}

                {children.length > 0 ? (
                    <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--app-hint)]">
                            {t('sessions.lineage.childrenLabel')} ({children.length})
                        </span>
                        {visibleChildren.map((child) => {
                            const childTone = classifySummaryTone(child)
                            const childKind = child.metadata?.parentLink?.kind ?? 'peer'
                            return (
                                <SessionLinkAnchor
                                    key={child.id}
                                    sessionId={child.id}
                                    className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-[var(--app-border)] bg-[var(--app-bg)] px-2.5 py-0.5 text-xs text-[var(--app-fg)] transition-colors hover:border-[var(--app-link)] hover:text-[var(--app-link)]"
                                >
                                    <StatusDot tone={childTone} />
                                    <span aria-hidden="true">↳</span>
                                    <span className="truncate max-w-44">{getSessionTitle(child)}</span>
                                    <KindTag kind={childKind} />
                                </SessionLinkAnchor>
                            )
                        })}
                        {hiddenChildCount > 0 ? (
                            <button
                                type="button"
                                onClick={() => setShowAllChildren(true)}
                                className="rounded-full border border-dashed border-[var(--app-border)] px-2 py-0.5 text-[11px] text-[var(--app-hint)] transition-colors hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)]"
                            >
                                {t('sessions.lineage.showMoreChildren', { count: hiddenChildCount })}
                            </button>
                        ) : null}
                    </div>
                ) : null}
            </div>
        </div>
    )
}
