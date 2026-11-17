import { useContext, useEffect, useState, type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from 'react'
import { QueryClientContext } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import type { SessionSummary, SessionsResponse } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'
import { PRESERVE_SESSION_SIDEBAR_SCROLL } from '@/lib/sessionNavigation'
import { buildSessionReferencePath } from '@/lib/sessionReference'
import { getSessionTitle } from '@/lib/sessionTitle'
import { useTranslation } from '@/lib/use-translation'

type SessionLinkAnchorProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & {
    sessionId: string
    children: ReactNode
}

export function SessionLinkAnchor({ sessionId, onClick, children, ...rest }: SessionLinkAnchorProps) {
    const router = useRouter({ warn: false }) as { navigate?: (opts: unknown) => unknown } | undefined
    const href = buildSessionReferencePath(sessionId)

    const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(event)
        if (event.defaultPrevented) return
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
        if (typeof router?.navigate !== 'function') return

        event.preventDefault()
        void router.navigate({
            to: '/sessions/$sessionId',
            params: { sessionId },
            ...PRESERVE_SESSION_SIDEBAR_SCROLL
        })
    }

    return (
        <a {...rest} href={href} onClick={handleClick}>
            {children}
        </a>
    )
}

export function useSessionByNativeAgentId(nativeSessionId: string | null | undefined): SessionSummary | null {
    const queryClient = useContext(QueryClientContext)
    const [, setCacheTick] = useState(0)

    useEffect(() => {
        if (!queryClient || !nativeSessionId) return
        return queryClient.getQueryCache().subscribe((event) => {
            if (event.query.queryKey[0] === queryKeys.sessions[0]) {
                setCacheTick((n) => n + 1)
            }
        })
    }, [queryClient, nativeSessionId])

    if (!queryClient || !nativeSessionId) return null
    const data = queryClient.getQueryData<SessionsResponse>(queryKeys.sessions)
    return data?.sessions.find((s) => s.metadata?.agentSessionId === nativeSessionId) ?? null
}

export function LinkedNativeSessionChip(props: {
    nativeSessionId: string | null | undefined
    fallbackLabel?: string | null
    className?: string
}) {
    const { t } = useTranslation()
    const matched = useSessionByNativeAgentId(props.nativeSessionId)
    if (!matched) return null
    const title = getSessionTitle(matched) || props.fallbackLabel?.trim() || matched.id.slice(0, 8)

    return (
        <SessionLinkAnchor
            sessionId={matched.id}
            aria-label={`${t('sessions.lineage.openSession')}: ${title}`}
            title={title}
            className={props.className ?? 'inline-flex min-h-7 max-w-full items-center gap-1.5 rounded-full border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-2.5 py-1 text-xs font-medium text-[var(--app-link)] transition-colors hover:border-[var(--app-link)] touch-manipulation sm:min-h-0'}
        >
            <span aria-hidden="true">↳</span>
            <span className="max-w-48 truncate sm:max-w-64">{title}</span>
            <span aria-hidden="true" className="shrink-0 opacity-70">›</span>
        </SessionLinkAnchor>
    )
}
