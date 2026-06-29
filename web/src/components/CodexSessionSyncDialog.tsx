import { useEffect, useState } from 'react'
import type { CodexLocalSessionSummary } from '@/types/api'
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { SessionImportPicker } from '@/components/SessionImportPicker'
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

export function CodexSessionSyncDialog(props: {
    isOpen: boolean
    onClose: () => void
    sessions: CodexLocalSessionSummary[]
    currentCodexSessionId: string | null
    onConfirm: (sessionIds: string[]) => Promise<void>
    onRestartCodexDesktop: () => Promise<void>
    isPending: boolean
    isRestartingCodexDesktop: boolean
    isLoading: boolean
}) {
    const { t } = useTranslation()
    const {
        isOpen,
        sessions,
        currentCodexSessionId,
        onConfirm,
        onRestartCodexDesktop,
        isPending,
        isRestartingCodexDesktop,
        isLoading,
        onClose
    } = props
    const [selectedSessionIds, setSelectedSessionIds] = useState<string[]>([])

    useEffect(() => {
        if (!isOpen) {
            setSelectedSessionIds([])
        }
    }, [isOpen])

    const handleConfirm = async () => {
        if (selectedSessionIds.length === 0 || isPending || isLoading) return

        // 中文注释：确认按钮只提交用户在弹窗中勾选的 Codex thread，实际导入逻辑由父组件统一处理并给出 toast 提示。
        await onConfirm(selectedSessionIds)
    }

    return (
        <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-xl">
                <div className="flex items-start justify-between gap-3 pr-10" data-testid="codex-import-dialog-header">
                    <DialogHeader className="min-w-0 flex-1 pr-0 text-left">
                        <DialogTitle>{t('codexSync.confirm.title')}</DialogTitle>
                        <DialogDescription className="mt-2">
                            {t('codexSync.confirm.description')}
                        </DialogDescription>
                    </DialogHeader>
                    <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        className="shrink-0"
                        onClick={() => void onRestartCodexDesktop()}
                        disabled={isRestartingCodexDesktop}
                        aria-label={t('codexSync.restart.tooltip')}
                        title={t('codexSync.restart.tooltip')}
                    >
                        {/* 中文注释：右侧预留关闭按钮区域，重启按钮保持在标题行右侧但不压到关闭按钮。 */}
                        {isRestartingCodexDesktop ? t('codexSync.restart.confirming') : t('codexSync.restart.tooltip')}
                    </Button>
                </div>

                <SessionImportPicker
                    isOpen={isOpen}
                    sessions={sessions}
                    currentSessionId={currentCodexSessionId}
                    selectedSessionIds={selectedSessionIds}
                    onSelectionChange={setSelectedSessionIds}
                    isPending={isPending}
                    isLoading={isLoading}
                    labels={CODEX_IMPORT_PICKER_LABELS}
                />

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
                        disabled={isPending || isLoading || selectedSessionIds.length === 0}
                    >
                        {isPending ? t('codexSync.confirm.confirming') : t('codexSync.confirm.confirm')}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    )
}
