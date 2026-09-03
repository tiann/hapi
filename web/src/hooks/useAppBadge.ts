import { useEffect, useRef } from 'react'
import type { SessionSummary } from '@/types/api'
import { sessionIsUnread } from '@/lib/sessionAttention'
import {
    getSessionLastSeenSnapshot,
    initializeSessionLastSeen,
    useSessionLastSeenVersion,
} from '@/lib/sessionLastSeen'

type AppBadgeNavigator = Navigator & {
    setAppBadge?: (contents?: number) => Promise<void>
    clearAppBadge?: () => Promise<void>
}

export type UseAppBadgeOptions = {
    enabled: boolean
    scope: string
    sessions: readonly SessionSummary[]
    isLoading: boolean
    hasError: boolean
}

function getAppBadgeNavigator(): AppBadgeNavigator | null {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') {
        return null
    }

    if (
        typeof window.matchMedia !== 'function'
        || !window.matchMedia('(display-mode: standalone)').matches
    ) {
        return null
    }

    const appBadgeNavigator = navigator as AppBadgeNavigator
    if (typeof appBadgeNavigator.setAppBadge !== 'function') {
        return null
    }

    return appBadgeNavigator
}

/** True when this context can update the installed PWA's app icon badge. */
export function canUseAppBadging(): boolean {
    return getAppBadgeNavigator() !== null
}

/** Count sessions whose activity is newer than their local watermark. */
export function countUnreadSessions(
    sessions: readonly SessionSummary[],
    lastSeenById: Readonly<Record<string, number>>,
): number {
    return sessions.reduce(
        (count, session) => count + (
            sessionIsUnread(session, { lastSeenAt: lastSeenById[session.id] ?? 0 })
                ? 1
                : 0
        ),
        0,
    )
}

function requestBadgeUpdate(
    appBadgeNavigator: AppBadgeNavigator,
    count: number,
): Promise<void> | null {
    try {
        if (count > 0) {
            return typeof appBadgeNavigator.setAppBadge === 'function'
                ? appBadgeNavigator.setAppBadge(count)
                : null
        }

        if (typeof appBadgeNavigator.clearAppBadge === 'function') {
            return appBadgeNavigator.clearAppBadge()
        }

        return typeof appBadgeNavigator.setAppBadge === 'function'
            ? appBadgeNavigator.setAppBadge(0)
            : null
    } catch (error) {
        return Promise.reject(error)
    }
}

function syncBadge(
    appBadgeNavigator: AppBadgeNavigator,
    count: number,
    lastAppliedCountRef: { current: number | null },
): void {
    if (lastAppliedCountRef.current === count) {
        return
    }

    const update = requestBadgeUpdate(appBadgeNavigator, count)
    if (!update) {
        return
    }

    lastAppliedCountRef.current = count
    void update.catch(() => {
        // Retry after a transient browser/OS failure on the next render.
        if (lastAppliedCountRef.current === count) {
            lastAppliedCountRef.current = null
        }
    })
}

export function useAppBadge(options: UseAppBadgeOptions): void {
    const lastSeenVersion = useSessionLastSeenVersion()
    const lastAppliedCountRef = useRef<number | null>(null)

    useEffect(() => {
        const appBadgeNavigator = getAppBadgeNavigator()
        if (!appBadgeNavigator) {
            return
        }

        if (!options.enabled) {
            syncBadge(appBadgeNavigator, 0, lastAppliedCountRef)
            return
        }

        // Keep the previous signal while a temporary refetch is in flight or
        // failed. The next successful session snapshot will reconcile it.
        if (options.isLoading || options.hasError) {
            return
        }

        // Match the session list's first-load baseline so existing sessions do
        // not all appear unread when a user installs the PWA for the first time.
        initializeSessionLastSeen(options.scope, options.sessions)
        const count = countUnreadSessions(options.sessions, getSessionLastSeenSnapshot())
        syncBadge(appBadgeNavigator, count, lastAppliedCountRef)
    }, [
        lastSeenVersion,
        options.enabled,
        options.hasError,
        options.isLoading,
        options.scope,
        options.sessions,
    ])
}
