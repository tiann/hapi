import type { ImportableSessionView } from '@/types/api'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/lib/use-translation'

function formatTimestamp(timestamp: number | null): string {
    if (!timestamp) {
        return 'Unknown time'
    }

    try {
        return new Intl.DateTimeFormat(undefined, {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
        }).format(timestamp)
    } catch {
        return 'Unknown time'
    }
}

export function ImportableSessionList(props: {
    sessions: ImportableSessionView[]
    selectedExternalSessionId: string | null
    importingSessionId: string | null
    reimportingSessionId: string | null
    onSelect: (externalSessionId: string) => void
    onImport: (externalSessionId: string) => void
    onReimport: (externalSessionId: string) => void
    onOpen: (sessionId: string) => void
}) {
    const { t } = useTranslation()
    const selectedSession = props.sessions.find((session) => session.externalSessionId === props.selectedExternalSessionId)
        ?? props.sessions[0]
        ?? null

    return (
        <div className="grid min-w-0 gap-3 md:grid-cols-[minmax(0,280px)_minmax(0,1fr)] md:gap-4">
            <div className="min-h-0 min-w-0 overflow-hidden rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)]">
                <div className="max-h-[32dvh] overflow-y-auto md:max-h-[420px]">
                    {props.sessions.map((session) => {
                        const selected = session.externalSessionId === selectedSession?.externalSessionId
                        return (
                            <button
                                key={session.externalSessionId}
                                type="button"
                                onClick={() => props.onSelect(session.externalSessionId)}
                                className={`flex w-full flex-col gap-1 border-b border-[var(--app-divider)] px-3 py-3 text-left transition-colors last:border-b-0 ${
                                    selected ? 'bg-[var(--app-subtle-bg)]' : 'hover:bg-[var(--app-subtle-bg)]/70'
                                }`}
                            >
                                <div className="flex items-start justify-between gap-2">
                                    <div className="min-w-0 text-sm font-medium text-[var(--app-fg)]">
                                        <div className="truncate">{session.previewTitle ?? session.previewPrompt ?? session.externalSessionId}</div>
                                    </div>
                                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                                        session.alreadyImported
                                            ? 'bg-emerald-500/15 text-emerald-700'
                                            : 'bg-[var(--app-subtle-bg)] text-[var(--app-hint)]'
                                    }`}>
                                        {session.alreadyImported ? t('newSession.import.badgeImported') : t('newSession.import.badgeReady')}
                                    </span>
                                </div>
                                <div className="truncate text-xs text-[var(--app-hint)]">{session.cwd ?? t('newSession.import.unknownDirectory')}</div>
                                <div className="text-xs text-[var(--app-hint)]">{formatTimestamp(session.timestamp)}</div>
                            </button>
                        )
                    })}
                </div>
            </div>

            <div className="flex min-h-0 min-w-0 flex-col rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)] p-3 sm:p-4">
                {selectedSession ? (
                    <>
                        <div className="mb-4 space-y-2">
                            <div className="break-words text-base font-semibold text-[var(--app-fg)] sm:text-lg">
                                {selectedSession.previewTitle ?? selectedSession.previewPrompt ?? selectedSession.externalSessionId}
                            </div>
                            <div className="break-all text-sm text-[var(--app-hint)]">{selectedSession.cwd ?? t('newSession.import.unknownDirectory')}</div>
                            <div className="text-xs text-[var(--app-hint)]">{formatTimestamp(selectedSession.timestamp)}</div>
                        </div>

                        <div className="mb-4 grid gap-3 rounded-lg bg-[var(--app-subtle-bg)] p-3 text-sm">
                            <div>
                                <div className="mb-1 text-xs font-medium uppercase tracking-wide text-[var(--app-hint)]">{t('newSession.import.preview')}</div>
                                <div className="whitespace-pre-wrap break-words text-[var(--app-fg)]">
                                    {selectedSession.previewPrompt ?? t('newSession.import.noPreview')}
                                </div>
                            </div>
                            <div>
                                <div className="mb-1 text-xs font-medium uppercase tracking-wide text-[var(--app-hint)]">{t('newSession.import.transcript')}</div>
                                <div className="break-all text-[var(--app-hint)]">{selectedSession.transcriptPath}</div>
                            </div>
                        </div>

                        <div className="mt-auto flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                            {selectedSession.alreadyImported && selectedSession.importedHapiSessionId ? (
                                <>
                                    <Button
                                        type="button"
                                        className="w-full sm:w-auto"
                                        onClick={() => props.onOpen(selectedSession.importedHapiSessionId!)}
                                    >
                                        {t('newSession.import.open')}
                                    </Button>
                                    <Button
                                        type="button"
                                        variant="secondary"
                                        className="w-full sm:w-auto"
                                        onClick={() => props.onReimport(selectedSession.externalSessionId)}
                                        disabled={props.reimportingSessionId === selectedSession.externalSessionId}
                                    >
                                        {props.reimportingSessionId === selectedSession.externalSessionId
                                            ? t('newSession.import.reimporting')
                                            : t('newSession.import.reimport')}
                                    </Button>
                                </>
                            ) : (
                                <Button
                                    type="button"
                                    className="w-full sm:w-auto"
                                    onClick={() => props.onImport(selectedSession.externalSessionId)}
                                    disabled={props.importingSessionId === selectedSession.externalSessionId}
                                >
                                    {props.importingSessionId === selectedSession.externalSessionId
                                        ? t('newSession.import.importing')
                                        : t('newSession.import.cta')}
                                </Button>
                            )}
                        </div>
                    </>
                ) : null}
            </div>
        </div>
    )
}
