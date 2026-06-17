import { useEffect, useMemo, useState } from 'react'
import type {
    AgentImportFlavor,
    CodexLocalSessionSummary,
    CursorImportableSessionSummary,
    CursorImportRefusalReason,
    CursorImportRowOutcome
} from '@/types/api'
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { SessionImportPicker, type ImportSessionSummary } from '@/components/SessionImportPicker'
import { useTranslation } from '@/lib/use-translation'

const CODEX_IMPORT_PICKER_LABELS = {
    selectedCount: 'codexSync.confirm.selectedCount',
    selectAll: 'codexSync.confirm.selectAll',
    clearAll: 'codexSync.confirm.clearAll',
    cwdFilter: 'codexSync.confirm.cwdFilter',
    cwdFilterAll: 'codexSync.confirm.cwdFilterAll',
    cwd: 'codexSync.confirm.cwd',
    current: 'codexSync.confirm.current',
    loading: 'codexSync.confirm.loading',
    empty: 'codexSync.confirm.empty',
    emptyForWorkdir: 'codexSync.confirm.emptyForWorkdir'
} as const

const CURSOR_IMPORT_PICKER_LABELS = {
    selectedCount: 'cursorSync.confirm.selectedCount',
    selectAll: 'cursorSync.confirm.selectAll',
    clearAll: 'cursorSync.confirm.clearAll',
    cwdFilter: 'cursorSync.confirm.cwdFilter',
    cwdFilterAll: 'cursorSync.confirm.cwdFilterAll',
    cwd: 'cursorSync.confirm.cwd',
    current: 'cursorSync.confirm.current',
    loading: 'cursorSync.confirm.loading',
    empty: 'cursorSync.confirm.empty',
    emptyForWorkdir: 'cursorSync.confirm.emptyForWorkdir'
} as const

function toCodexImportSession(session: CodexLocalSessionSummary): ImportSessionSummary {
    return {
        id: session.id,
        title: session.title,
        lastUserMessage: session.lastUserMessage,
        cwd: session.cwd,
        modifiedAt: session.modifiedAt,
        originator: session.originator,
        cliVersion: session.cliVersion
    }
}

function toCursorImportSession(session: CursorImportableSessionSummary): ImportSessionSummary {
    return {
        id: session.id,
        title: session.title,
        lastUserMessage: session.firstUserMessage,
        cwd: session.workspacePath,
        modifiedAt: session.modifiedAt
    }
}

function cursorRefusalKey(reason: CursorImportRefusalReason): string {
    return `cursorSync.refusal.${reason}`
}

export function AgentSessionImportDialog(props: {
    isOpen: boolean
    onClose: () => void
    flavor: AgentImportFlavor
    onChangeFlavor: (flavor: AgentImportFlavor) => void
    codexSessions: CodexLocalSessionSummary[]
    currentCodexSessionId: string | null
    isLoadingCodex: boolean
    isPendingCodex: boolean
    isRestartingCodexDesktop: boolean
    onConfirmCodex: (sessionIds: string[]) => Promise<void>
    onRestartCodexDesktop: () => Promise<void>
    cursorSessions: CursorImportableSessionSummary[]
    isLoadingCursor: boolean
    isPendingCursor: boolean
    cursorLastOutcomes: CursorImportRowOutcome[] | null
    onConfirmCursor: (uuids: string[]) => Promise<void>
}) {
    const { t } = useTranslation()
    const {
        isOpen,
        onClose,
        flavor,
        onChangeFlavor,
        codexSessions,
        currentCodexSessionId,
        isLoadingCodex,
        isPendingCodex,
        isRestartingCodexDesktop,
        onConfirmCodex,
        onRestartCodexDesktop,
        cursorSessions,
        isLoadingCursor,
        isPendingCursor,
        cursorLastOutcomes,
        onConfirmCursor
    } = props

    const [selectedCodexIds, setSelectedCodexIds] = useState<string[]>([])
    const [selectedCursorIds, setSelectedCursorIds] = useState<string[]>([])

    const isPending = flavor === 'codex' ? isPendingCodex : isPendingCursor
    const isLoading = flavor === 'codex' ? isLoadingCodex : isLoadingCursor

    const codexImportSessions = useMemo(
        () => codexSessions.map(toCodexImportSession),
        [codexSessions]
    )
    const cursorImportSessions = useMemo(
        () => cursorSessions.map(toCursorImportSession),
        [cursorSessions]
    )

    const cursorSessionsById = useMemo(() => {
        const map = new Map<string, CursorImportableSessionSummary>()
        for (const session of cursorSessions) {
            map.set(session.id, session)
        }
        return map
    }, [cursorSessions])

    const outcomesByUuid = useMemo(() => {
        const map = new Map<string, CursorImportRowOutcome>()
        for (const outcome of cursorLastOutcomes ?? []) {
            map.set(outcome.uuid, outcome)
        }
        return map
    }, [cursorLastOutcomes])

    useEffect(() => {
        if (!isOpen) {
            setSelectedCodexIds([])
            setSelectedCursorIds([])
        }
    }, [isOpen])

    const handleConfirm = async () => {
        if (flavor === 'codex') {
            if (selectedCodexIds.length === 0 || isPendingCodex || isLoadingCodex) return
            await onConfirmCodex(selectedCodexIds)
            return
        }
        if (selectedCursorIds.length === 0 || isPendingCursor || isLoadingCursor) return
        await onConfirmCursor(selectedCursorIds)
    }

    return (
        <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-xl">
                <div className="flex items-start justify-between gap-3">
                    <DialogHeader className="flex-1 text-left">
                        <DialogTitle>{t('agentImport.confirm.title')}</DialogTitle>
                        <DialogDescription className="mt-2">
                            {flavor === 'codex'
                                ? t('codexSync.confirm.description')
                                : t('cursorSync.confirm.description')}
                        </DialogDescription>
                    </DialogHeader>
                    {flavor === 'codex' ? (
                        <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            onClick={() => void onRestartCodexDesktop()}
                            disabled={isRestartingCodexDesktop}
                            aria-label={t('codexSync.restart.tooltip')}
                            title={t('codexSync.restart.tooltip')}
                        >
                            {isRestartingCodexDesktop
                                ? t('codexSync.restart.confirming')
                                : t('codexSync.restart.tooltip')}
                        </Button>
                    ) : null}
                </div>

                <div
                    role="tablist"
                    aria-label={t('agentImport.flavor.label')}
                    className="mt-3 inline-flex w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-0.5"
                >
                    <button
                        type="button"
                        role="tab"
                        aria-selected={flavor === 'codex'}
                        disabled={isPending || isLoading}
                        onClick={() => onChangeFlavor('codex')}
                        className={`flex-1 rounded-md px-3 py-1.5 text-xs transition-colors disabled:opacity-60 ${
                            flavor === 'codex'
                                ? 'bg-[var(--app-secondary-bg)] text-[var(--app-fg)] shadow-sm'
                                : 'text-[var(--app-hint)] hover:text-[var(--app-fg)]'
                        }`}
                    >
                        {t('agentImport.flavor.codex')}
                    </button>
                    <button
                        type="button"
                        role="tab"
                        aria-selected={flavor === 'cursor'}
                        disabled={isPending || isLoading}
                        onClick={() => onChangeFlavor('cursor')}
                        className={`flex-1 rounded-md px-3 py-1.5 text-xs transition-colors disabled:opacity-60 ${
                            flavor === 'cursor'
                                ? 'bg-[var(--app-secondary-bg)] text-[var(--app-fg)] shadow-sm'
                                : 'text-[var(--app-hint)] hover:text-[var(--app-fg)]'
                        }`}
                    >
                        {t('agentImport.flavor.cursor')}
                    </button>
                </div>

                {flavor === 'codex' ? (
                    <SessionImportPicker
                        isOpen={isOpen}
                        sessions={codexImportSessions}
                        currentSessionId={currentCodexSessionId}
                        selectedSessionIds={selectedCodexIds}
                        onSelectionChange={setSelectedCodexIds}
                        isPending={isPendingCodex}
                        isLoading={isLoadingCodex}
                        labels={CODEX_IMPORT_PICKER_LABELS}
                    />
                ) : (
                    <>
                        <div className="mt-3 rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-2 text-[11px] text-[var(--app-hint)]">
                            {t('cursorSync.confirm.acpStrictHint')}
                        </div>
                        <SessionImportPicker
                            isOpen={isOpen}
                            sessions={cursorImportSessions}
                            currentSessionId={null}
                            selectedSessionIds={selectedCursorIds}
                            onSelectionChange={setSelectedCursorIds}
                            isPending={isPendingCursor}
                            isLoading={isLoadingCursor}
                            labels={CURSOR_IMPORT_PICKER_LABELS}
                            isSessionDisabled={(session) => {
                                const raw = cursorSessionsById.get(session.id)
                                return Boolean(raw?.alreadyImportedHapiSessionId)
                            }}
                            renderSessionBadges={(session) => {
                                const raw = cursorSessionsById.get(session.id)
                                if (!raw) return null
                                const outcome = outcomesByUuid.get(session.id)
                                return (
                                    <>
                                        <span className="shrink-0 rounded-full bg-[var(--app-secondary-bg)] px-2 py-0.5 text-[10px] text-[var(--app-hint)]">
                                            {raw.sourceFormat === 'acp'
                                                ? t('cursorSync.confirm.sourceAcp')
                                                : t('cursorSync.confirm.sourceLegacy')}
                                        </span>
                                        {raw.alreadyImportedHapiSessionId ? (
                                            <span className="shrink-0 rounded-full bg-[var(--app-secondary-bg)] px-2 py-0.5 text-[10px] text-[var(--app-hint)]">
                                                {t('cursorSync.confirm.alreadyImported')}
                                            </span>
                                        ) : null}
                                        {outcome?.ok ? (
                                            <span className="shrink-0 rounded-full bg-[var(--app-secondary-bg)] px-2 py-0.5 text-[10px] text-[var(--app-fg)]">
                                                {t('cursorSync.outcome.ok')}
                                            </span>
                                        ) : null}
                                    </>
                                )
                            }}
                            renderSessionFooter={(session) => {
                                const outcome = outcomesByUuid.get(session.id)
                                if (!outcome || outcome.ok) return null
                                return (
                                    <div className="mt-1 rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-2 py-1 text-[11px] text-[var(--app-fg)]">
                                        <div className="font-medium">
                                            {t(cursorRefusalKey(outcome.reason))}
                                        </div>
                                        <div className="mt-0.5 break-words text-[10px] text-[var(--app-hint)]">
                                            {outcome.message}
                                        </div>
                                    </div>
                                )
                            }}
                        />
                    </>
                )}

                <div className="mt-4 flex justify-end gap-2">
                    <Button
                        type="button"
                        variant="secondary"
                        onClick={onClose}
                        disabled={isPending || isRestartingCodexDesktop}
                    >
                        {t('button.cancel')}
                    </Button>
                    <Button
                        type="button"
                        variant="secondary"
                        onClick={() => void handleConfirm()}
                        disabled={
                            isPending
                            || isLoading
                            || (flavor === 'codex' ? selectedCodexIds.length === 0 : selectedCursorIds.length === 0)
                        }
                    >
                        {isPending
                            ? (flavor === 'codex'
                                ? t('codexSync.confirm.confirming')
                                : t('cursorSync.confirm.confirming'))
                            : (flavor === 'codex'
                                ? t('codexSync.confirm.confirm')
                                : t('cursorSync.confirm.confirm'))}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    )
}
