import { useMemo } from 'react'
import { useNavigate } from '@tanstack/react-router'
import type { ApiClient } from '@/api/client'
import { useSessions } from '@/hooks/queries/useSessions'
import { useTranslation } from '@/lib/use-translation'
import type { SessionSummary } from '@/types/api'

export type PendingPromptsSummary = {
    totalPrompts: number
    sessionsWithPending: SessionSummary[]
}

function getSessionTitle(session: SessionSummary): string {
    if (session.metadata?.name) return session.metadata.name
    if (session.metadata?.summary?.text) return session.metadata.summary.text
    if (session.metadata?.path) {
        const parts = session.metadata.path.split('/').filter(Boolean)
        return parts[parts.length - 1] ?? session.id.slice(0, 8)
    }
    return session.id.slice(0, 8)
}

export function summarizePendingPrompts(sessions: SessionSummary[], excludeSessionId?: string | null): PendingPromptsSummary {
    const sessionsWithPending = sessions
        .filter(session => session.pendingRequestsCount > 0 && session.id !== excludeSessionId)
        .sort((a, b) => {
            if (a.pendingRequestsCount !== b.pendingRequestsCount) {
                return b.pendingRequestsCount - a.pendingRequestsCount
            }
            return b.updatedAt - a.updatedAt
        })

    const totalPrompts = sessionsWithPending.reduce(
        (sum, session) => sum + session.pendingRequestsCount,
        0
    )

    return {
        totalPrompts,
        sessionsWithPending
    }
}

export function PendingPromptsBanner(props: {
    api: ApiClient | null
    currentSessionId?: string | null
}) {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const { sessions } = useSessions(props.api)

    const summary = useMemo(
        () => summarizePendingPrompts(sessions, props.currentSessionId),
        [sessions, props.currentSessionId]
    )

    if (summary.totalPrompts <= 0) {
        return null
    }

    const primarySession = summary.sessionsWithPending[0]
    if (!primarySession) {
        return null
    }

    const primaryName = getSessionTitle(primarySession)

    return (
        <div className="fixed top-0 left-0 right-0 z-40 animate-slide-down pt-[env(safe-area-inset-top)]">
            <div className="border-b border-[var(--app-divider)] bg-amber-50/90 px-3 py-2 shadow-sm dark:bg-amber-500/10">
                <div className="mx-auto flex w-full max-w-content items-center justify-between gap-3">
                    <div className="min-w-0 flex-1 text-xs text-amber-900 dark:text-amber-100">
                        <div className="truncate">
                            {t('pendingPrompts.message', {
                                n: summary.totalPrompts,
                                m: summary.sessionsWithPending.length,
                                name: primaryName
                            })}
                        </div>
                    </div>
                    <button
                        type="button"
                        className="inline-flex min-h-[44px] shrink-0 items-center rounded bg-amber-500 px-3 text-xs font-medium text-white hover:bg-amber-600"
                        onClick={() => {
                            navigate({
                                to: '/sessions/$sessionId',
                                params: { sessionId: primarySession.id }
                            })
                        }}
                    >
                        {t('pendingPrompts.open')}
                    </button>
                </div>
            </div>
        </div>
    )
}
