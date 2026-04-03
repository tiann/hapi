import { useEffect, useMemo, useState } from 'react'
import type { ApiClient } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useImportableSessionActions } from '@/hooks/mutations/useImportableSessionActions'
import { useImportableSessions } from '@/hooks/queries/useImportableSessions'
import type { ImportableSessionAgent } from '@/types/api'
import { useTranslation } from '@/lib/use-translation'
import { ImportableSessionList } from './ImportableSessionList'

function ImportExistingAgentPanel(props: {
    api: ApiClient
    agent: ImportableSessionAgent
    open: boolean
    search: string
    onOpenSession: (sessionId: string) => void
}) {
    const { t } = useTranslation()
    const { sessions, isLoading, error, refetch } = useImportableSessions(props.api, props.agent, props.open)
    const {
        importSession,
        refreshSession,
        importingSessionId,
        refreshingSessionId,
        error: actionError,
    } = useImportableSessionActions(props.api, props.agent)
    const [selectedExternalSessionId, setSelectedExternalSessionId] = useState<string | null>(null)

    const filteredSessions = useMemo(() => {
        const query = props.search.trim().toLowerCase()
        if (!query) {
            return sessions
        }

        return sessions.filter((session) => {
            const haystacks = [
                session.previewTitle,
                session.previewPrompt,
                session.cwd,
                session.externalSessionId,
            ]
            return haystacks.some((value) => value?.toLowerCase().includes(query))
        })
    }, [props.search, sessions])

    useEffect(() => {
        if (!props.open) {
            setSelectedExternalSessionId(null)
            return
        }

        if (!filteredSessions.find((session) => session.externalSessionId === selectedExternalSessionId)) {
            setSelectedExternalSessionId(filteredSessions[0]?.externalSessionId ?? null)
        }
    }, [filteredSessions, props.open, selectedExternalSessionId])

    const handleImport = async (externalSessionId: string) => {
        const result = await importSession(externalSessionId)
        props.onOpenSession(result.sessionId)
    }

    return (
        <div className="space-y-4">
            <div className="flex justify-end">
                <Button type="button" variant="secondary" onClick={() => void refetch()} className="sm:self-auto">
                    {t('newSession.import.refreshList')}
                </Button>
            </div>

            {isLoading ? (
                <div className="rounded-lg border border-[var(--app-divider)] px-4 py-10 text-center text-sm text-[var(--app-hint)]">
                    {t('newSession.import.loading')}
                </div>
            ) : error ? (
                <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-6 text-sm text-red-700">
                    <div className="mb-3">{error}</div>
                    <Button type="button" variant="secondary" onClick={() => void refetch()}>
                        {t('newSession.import.retry')}
                    </Button>
                </div>
            ) : filteredSessions.length === 0 ? (
                <div className="rounded-lg border border-dashed border-[var(--app-divider)] px-4 py-10 text-center text-sm text-[var(--app-hint)]">
                    {sessions.length === 0
                        ? t('newSession.import.empty')
                        : t('newSession.import.emptySearch')}
                </div>
            ) : (
                <ImportableSessionList
                    sessions={filteredSessions}
                    selectedExternalSessionId={selectedExternalSessionId}
                    importingSessionId={importingSessionId}
                    refreshingSessionId={refreshingSessionId}
                    onSelect={setSelectedExternalSessionId}
                    onImport={(externalSessionId) => void handleImport(externalSessionId)}
                    onRefresh={(externalSessionId) => void refreshSession(externalSessionId)}
                    onOpen={props.onOpenSession}
                />
            )}

            {actionError ? (
                <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                    {actionError}
                </div>
            ) : null}
        </div>
    )
}

export function ImportExistingModal(props: {
    api: ApiClient
    open: boolean
    onOpenChange: (open: boolean) => void
    onOpenSession: (sessionId: string) => void
}) {
    const { t } = useTranslation()
    const [activeTab, setActiveTab] = useState<ImportableSessionAgent>('codex')
    const [search, setSearch] = useState('')

    useEffect(() => {
        if (!props.open) {
            setSearch('')
            setActiveTab('codex')
        }
    }, [props.open])

    return (
        <Dialog open={props.open} onOpenChange={props.onOpenChange}>
            <DialogContent className="w-[calc(100vw-12px)] max-w-5xl overflow-x-hidden p-0 sm:w-full">
                <div className="flex max-h-[calc(100dvh-24px)] flex-col">
                    <DialogHeader className="border-b border-[var(--app-divider)] px-3 py-4 sm:px-5">
                        <DialogTitle>{t('newSession.import.title')}</DialogTitle>
                        <DialogDescription>
                            {t('newSession.import.description')}
                        </DialogDescription>
                    </DialogHeader>

                    <div className="border-b border-[var(--app-divider)] px-3 pt-4 sm:px-5">
                        <div className="flex gap-2">
                            <button
                                type="button"
                                onClick={() => setActiveTab('codex')}
                                className={`rounded-t-lg px-3 py-2 text-sm font-medium ${
                                    activeTab === 'codex'
                                        ? 'bg-[var(--app-subtle-bg)] text-[var(--app-fg)]'
                                        : 'text-[var(--app-hint)]'
                                }`}
                            >
                                Codex
                            </button>
                            <button
                                type="button"
                                onClick={() => setActiveTab('claude')}
                                className={`rounded-t-lg px-3 py-2 text-sm font-medium ${
                                    activeTab === 'claude'
                                        ? 'bg-[var(--app-subtle-bg)] text-[var(--app-fg)]'
                                        : 'text-[var(--app-hint)]'
                                }`}
                            >
                                {t('newSession.import.tabs.claude')}
                            </button>
                        </div>
                    </div>

                    <div className="min-h-0 overflow-y-auto overflow-x-hidden px-3 py-4 sm:px-5">
                        <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
                            <input
                                type="text"
                                value={search}
                                onChange={(event) => setSearch(event.target.value)}
                                placeholder={t('newSession.import.searchPlaceholder')}
                                className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--app-link)]"
                            />
                        </div>
                        <ImportExistingAgentPanel
                            key={activeTab}
                            api={props.api}
                            agent={activeTab}
                            open={props.open}
                            search={search}
                            onOpenSession={props.onOpenSession}
                        />
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    )
}
