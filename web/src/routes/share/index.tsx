import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { useAppContext } from '@/lib/app-context'
import { useSessions } from '@/hooks/queries/useSessions'
import { useMachines } from '@/hooks/queries/useMachines'
import { useTranslation } from '@/lib/use-translation'
import { LoadingState } from '@/components/LoadingState'
import { SessionListSearch } from '@/components/SessionList'
import {
    countHiddenActiveSharePickerSessions,
    filterSharePickerSessions,
} from '@/lib/sharePickerSessions'
import {
    deleteShareTransfer,
    getShareTransfer,
    type ShareTransferPayload,
} from '@/lib/shareTransfer'
import { setSharePendingTransfer } from '@/lib/sharePendingState'
import type { SessionSummary } from '@/types/api'

type LoadState =
    | { state: 'loading' }
    | { state: 'missing'; reason: 'not-found' | 'ingest-error' | 'no-id' }
    | { state: 'ready'; payload: ShareTransferPayload }

function shortenText(text: string, max = 200): string {
    const trimmed = text.trim()
    if (trimmed.length <= max) return trimmed
    return trimmed.slice(0, max).trimEnd() + '…'
}

function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
    return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function getSessionTitle(session: SessionSummary): string {
    return session.metadata?.summary?.text
        ?? session.metadata?.name
        ?? session.metadata?.path
        ?? session.id.slice(0, 8)
}

function SharePreview(props: { payload: ShareTransferPayload }) {
    const { payload } = props
    const { t } = useTranslation()
    const firstImage = payload.files.find((f) => f.type.startsWith('image/'))
    const previewUrl = useMemo(() => {
        if (!firstImage) return null
        return URL.createObjectURL(firstImage.blob)
    }, [firstImage])
    useEffect(() => {
        return () => {
            if (previewUrl) URL.revokeObjectURL(previewUrl)
        }
    }, [previewUrl])

    if (payload.files.length === 0) {
        const fallback = payload.text || payload.url || payload.title
        return (
            <div className="rounded-md bg-[var(--app-secondary-bg)] p-3 text-sm text-[var(--app-fg)]">
                <div className="text-xs font-semibold text-[var(--app-hint)]">
                    {t('share.preview.text')}
                </div>
                <div className="mt-1 break-words">
                    {fallback ? shortenText(fallback) : t('share.preview.empty')}
                </div>
            </div>
        )
    }

    if (payload.files.length === 1) {
        const file = payload.files[0]
        return (
            <div className="flex items-start gap-3 rounded-md bg-[var(--app-secondary-bg)] p-3">
                {previewUrl ? (
                    <img
                        src={previewUrl}
                        alt={file.name}
                        className="h-16 w-16 rounded object-cover"
                    />
                ) : (
                    <div className="flex h-16 w-16 items-center justify-center rounded bg-[var(--app-subtle-bg)] text-xs uppercase text-[var(--app-hint)]">
                        {file.type.split('/')[1]?.slice(0, 4) ?? 'file'}
                    </div>
                )}
                <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-[var(--app-fg)]">
                        {file.name}
                    </div>
                    <div className="text-xs text-[var(--app-hint)]">
                        {formatBytes(file.blob.size)} · {file.type || 'application/octet-stream'}
                    </div>
                </div>
            </div>
        )
    }

    const summary = payload.files.slice(0, 3).map((f) => f.name).join(', ')
        + (payload.files.length > 3 ? '…' : '')
    return (
        <div className="rounded-md bg-[var(--app-secondary-bg)] p-3 text-sm text-[var(--app-fg)]">
            <div className="text-xs font-semibold text-[var(--app-hint)]">
                {t('share.preview.files', { n: payload.files.length })}
            </div>
            <div className="mt-1 break-words">{summary}</div>
        </div>
    )
}

export default function SharePage() {
    const { api } = useAppContext()
    const { t } = useTranslation()
    const navigate = useNavigate()
    const [load, setLoad] = useState<LoadState>({ state: 'loading' })
    const { sessions, isLoading: sessionsLoading } = useSessions(api)
    const { machines } = useMachines(api, true)
    const [searchQuery, setSearchQuery] = useState('')

    const machineLabelsById = useMemo(() => {
        const labels: Record<string, string> = {}
        for (const machine of machines) {
            if (machine.metadata?.displayName) {
                labels[machine.id] = machine.metadata.displayName
            } else if (machine.metadata?.host) {
                labels[machine.id] = machine.metadata.host
            } else {
                labels[machine.id] = machine.id.slice(0, 8)
            }
        }
        return labels
    }, [machines])

    const resolveMachineLabel = useCallback((machineId: string | null): string => {
        if (machineId && machineLabelsById[machineId]) {
            return machineLabelsById[machineId]
        }
        if (machineId) {
            return machineId.slice(0, 8)
        }
        return t('machine.unknown')
    }, [machineLabelsById, t])

    // Pulled via the typed validateSearch in router.tsx; reading
    // `window.location.search` directly would diverge from the rest of the
    // codebase and miss future schema tightening.
    const search = useSearch({ from: '/share' }) as { id?: string; error?: string }
    const transferId = search.id ?? null
    const ingestError = search.error === 'ingest'

    useEffect(() => {
        let cancelled = false
        if (ingestError) {
            setLoad({ state: 'missing', reason: 'ingest-error' })
            return
        }
        if (!transferId) {
            setLoad({ state: 'missing', reason: 'no-id' })
            return
        }
        getShareTransfer(transferId).then((payload) => {
            if (cancelled) return
            if (!payload) {
                setLoad({ state: 'missing', reason: 'not-found' })
                return
            }
            setLoad({ state: 'ready', payload })
        }).catch(() => {
            if (cancelled) return
            setLoad({ state: 'missing', reason: 'not-found' })
        })
        return () => { cancelled = true }
    }, [transferId, ingestError])

    // Snapshot the session list once when sessions finish loading so the
    // picker doesn't re-shuffle under the operator's finger as SSE updates
    // roll in. The picker is a one-shot interaction — closing the share
    // sheet and re-sharing produces a fresh snapshot.
    const [sessionsSnapshot, setSessionsSnapshot] = useState<SessionSummary[] | null>(null)
    useEffect(() => {
        if (sessionsSnapshot !== null) return
        if (sessionsLoading) return
        setSessionsSnapshot([...sessions])
    }, [sessionsSnapshot, sessions, sessionsLoading])

    const isSearching = searchQuery.trim().length > 0
    const pickerSessions = useMemo(() => {
        if (!sessionsSnapshot) return null
        return filterSharePickerSessions(sessionsSnapshot, searchQuery, resolveMachineLabel)
    }, [sessionsSnapshot, searchQuery, resolveMachineLabel])

    const hiddenActiveCount = useMemo(() => {
        if (!sessionsSnapshot || isSearching) return 0
        return countHiddenActiveSharePickerSessions(sessionsSnapshot)
    }, [sessionsSnapshot, isSearching])

    const handlePickSession = useCallback((sessionId: string) => {
        if (!transferId) return
        // Don't await deleteShareTransfer here — SessionChat consumes the
        // payload then deletes the IDB row (it owns the lifecycle once we
        // hand off). If we delete here, SessionChat won't find it.
        setSharePendingTransfer(transferId)
        navigate({ to: '/sessions/$sessionId', params: { sessionId } })
    }, [navigate, transferId])

    const handleNewSession = useCallback(() => {
        if (!transferId) return
        // Pass the transfer id via route search — do NOT arm sessionStorage here.
        // Arming before the session exists leaves a stale id that the next
        // unrelated SessionChat mount would consume (cancel/spawn-fail path).
        navigate({ to: '/sessions/new', search: { shareTransferId: transferId } })
    }, [navigate, transferId])

    const handleDiscard = useCallback(() => {
        if (transferId) {
            void deleteShareTransfer(transferId)
        }
        navigate({ to: '/sessions', replace: true })
    }, [navigate, transferId])

    if (load.state === 'loading') {
        return (
            <div className="flex h-full flex-col items-center justify-center p-4">
                <LoadingState label={t('share.loading')} className="text-sm" />
            </div>
        )
    }

    if (load.state === 'missing') {
        const reasonKey = load.reason === 'ingest-error'
            ? 'share.error.ingest'
            : load.reason === 'no-id'
                ? 'share.error.noId'
                : 'share.notFound.body'
        return (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
                <div className="text-sm font-medium text-[var(--app-fg)]">
                    {t('share.notFound.title')}
                </div>
                <div className="max-w-md text-xs text-[var(--app-hint)]">
                    {t(reasonKey)}
                </div>
                <button
                    type="button"
                    onClick={() => navigate({ to: '/sessions', replace: true })}
                    className="rounded-md bg-[var(--app-link)] px-3 py-1.5 text-sm text-white"
                >
                    {t('share.backToSessions')}
                </button>
            </div>
        )
    }

    const { payload } = load

    return (
        <div className="flex h-full min-h-0 flex-col bg-[var(--app-bg)]">
            <div className="border-b border-[var(--app-border)] bg-[var(--app-bg)] p-3 pt-[calc(0.75rem+env(safe-area-inset-top))]">
                <div className="mx-auto w-full max-w-content">
                    <div className="flex items-center justify-between gap-2">
                        <div className="font-semibold">{t('share.title')}</div>
                        <button
                            type="button"
                            onClick={handleDiscard}
                            className="rounded-md px-2 py-1 text-xs text-[var(--app-hint)] hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                        >
                            {t('share.discard')}
                        </button>
                    </div>
                    <div className="mt-1 text-xs text-[var(--app-hint)]">
                        {t('share.subtitle')}
                    </div>
                </div>
            </div>

            <div className="app-scroll-y flex-1 min-h-0">
                <div className="mx-auto w-full max-w-content space-y-4 p-3">
                    <SharePreview payload={payload} />

                    <div>
                        <div className="px-1 pb-1 text-xs font-semibold uppercase tracking-wide text-[var(--app-hint)]">
                            {isSearching ? t('share.searchResults') : t('share.recentSessions')}
                        </div>
                        <SessionListSearch value={searchQuery} onChange={setSearchQuery} />
                        {pickerSessions === null ? (
                            <LoadingState label={t('share.loading')} className="text-sm py-4" />
                        ) : pickerSessions.length === 0 ? (
                            <div className="rounded-md bg-[var(--app-secondary-bg)] p-3 text-xs text-[var(--app-hint)]">
                                {isSearching ? t('share.noSearchResults') : t('share.noActiveSessions')}
                            </div>
                        ) : (
                            <>
                                <ul className="overflow-hidden rounded-md bg-[var(--app-secondary-bg)]">
                                    {pickerSessions.map((session) => (
                                        <li key={session.id}>
                                            <button
                                                type="button"
                                                onClick={() => handlePickSession(session.id)}
                                                className="flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors hover:bg-[var(--app-subtle-bg)]"
                                            >
                                                <div className="min-w-0 flex-1">
                                                    <div className="truncate text-sm font-medium text-[var(--app-fg)]">
                                                        {getSessionTitle(session)}
                                                    </div>
                                                    {session.metadata?.path ? (
                                                        <div className="truncate text-xs text-[var(--app-hint)]">
                                                            {session.metadata.path}
                                                        </div>
                                                    ) : null}
                                                </div>
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                                {hiddenActiveCount > 0 ? (
                                    <div className="mt-2 px-1 text-xs text-[var(--app-hint)]">
                                        {t('share.searchForMore', { n: hiddenActiveCount })}
                                    </div>
                                ) : null}
                            </>
                        )}
                    </div>

                    <button
                        type="button"
                        onClick={handleNewSession}
                        className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-[var(--app-border)] px-3 py-3 text-sm font-medium text-[var(--app-link)] hover:bg-[var(--app-secondary-bg)]"
                    >
                        + {t('share.newSession')}
                    </button>
                </div>
            </div>
        </div>
    )
}
