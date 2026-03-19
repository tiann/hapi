import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import { queryKeys } from '@/lib/query-keys'
import type { SessionSummary } from '@/types/api'

const AUTO_ARCHIVE_TIMEOUT_KEY = 'hapi:auto-archive-timeout-ms'

export const AUTO_ARCHIVE_TIMEOUT_OPTIONS = [
    { value: 0, labelKey: 'settings.display.autoArchive.off' },
    { value: 15 * 60 * 1000, labelKey: 'settings.display.autoArchive.15m' },
    { value: 30 * 60 * 1000, labelKey: 'settings.display.autoArchive.30m' },
    { value: 60 * 60 * 1000, labelKey: 'settings.display.autoArchive.1h' },
    { value: 2 * 60 * 60 * 1000, labelKey: 'settings.display.autoArchive.2h' },
] as const

export type AutoArchiveTimeoutMs = (typeof AUTO_ARCHIVE_TIMEOUT_OPTIONS)[number]['value']

function isAutoArchiveTimeoutMs(value: number): value is AutoArchiveTimeoutMs {
    return AUTO_ARCHIVE_TIMEOUT_OPTIONS.some((option) => option.value === value)
}

function readAutoArchiveTimeoutPreference(): AutoArchiveTimeoutMs {
    if (typeof window === 'undefined') return 0
    try {
        const raw = localStorage.getItem(AUTO_ARCHIVE_TIMEOUT_KEY)
        const parsed = raw === null ? 0 : Number(raw)
        return isAutoArchiveTimeoutMs(parsed) ? parsed : 0
    } catch {
        return 0
    }
}

export function getAutoArchiveTimeoutOptions(): readonly { value: AutoArchiveTimeoutMs; labelKey: string }[] {
    return AUTO_ARCHIVE_TIMEOUT_OPTIONS
}

export function useAutoArchiveTimeout(): {
    autoArchiveTimeoutMs: AutoArchiveTimeoutMs
    setAutoArchiveTimeoutMs: (timeoutMs: AutoArchiveTimeoutMs) => void
} {
    const [autoArchiveTimeoutMs, setAutoArchiveTimeoutMsState] = useState<AutoArchiveTimeoutMs>(
        () => readAutoArchiveTimeoutPreference()
    )

    const setAutoArchiveTimeoutMs = (timeoutMs: AutoArchiveTimeoutMs) => {
        setAutoArchiveTimeoutMsState(timeoutMs)
        try {
            localStorage.setItem(AUTO_ARCHIVE_TIMEOUT_KEY, String(timeoutMs))
        } catch {
            // Ignore storage errors
        }
    }

    return {
        autoArchiveTimeoutMs,
        setAutoArchiveTimeoutMs
    }
}

function shouldAutoArchiveSession(session: SessionSummary, timeoutMs: number, now: number): boolean {
    if (timeoutMs <= 0) return false
    if (!session.active || session.thinking) return false
    if (session.pendingRequestsCount > 0) return false
    if (!Number.isFinite(session.updatedAt) || session.updatedAt <= 0) return false
    return now - session.updatedAt >= timeoutMs
}

export function useAutoArchive(
    api: ApiClient | null,
    sessions: SessionSummary[],
    timeoutMs: AutoArchiveTimeoutMs
): void {
    const queryClient = useQueryClient()
    const inFlightRef = useRef(new Set<string>())

    useEffect(() => {
        if (!api || timeoutMs <= 0) {
            return
        }

        let cancelled = false

        const run = async () => {
            const now = Date.now()
            const candidates = sessions.filter(
                (session) => shouldAutoArchiveSession(session, timeoutMs, now) && !inFlightRef.current.has(session.id)
            )

            if (candidates.length === 0) {
                return
            }

            const archivedSessionIds: string[] = []

            await Promise.all(candidates.map(async (session) => {
                inFlightRef.current.add(session.id)
                try {
                    await api.archiveSession(session.id)
                    archivedSessionIds.push(session.id)
                } catch (error) {
                    console.error(`Failed to auto-archive session ${session.id}:`, error)
                } finally {
                    inFlightRef.current.delete(session.id)
                }
            }))

            if (cancelled || archivedSessionIds.length === 0) {
                return
            }

            await queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
            await Promise.all(
                archivedSessionIds.map((sessionId) => queryClient.invalidateQueries({ queryKey: queryKeys.session(sessionId) }))
            )
        }

        void run()

        const intervalId = window.setInterval(() => {
            void run()
        }, Math.min(timeoutMs, 30_000))

        return () => {
            cancelled = true
            window.clearInterval(intervalId)
        }
    }, [api, queryClient, sessions, timeoutMs])
}
