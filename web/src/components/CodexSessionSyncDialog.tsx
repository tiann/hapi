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
                <div className="flex items-start justify-between gap-3">
                    <DialogHeader className="flex-1 text-left">
                        <DialogTitle>{t('codexSync.confirm.title')}</DialogTitle>
                        <DialogDescription className="mt-2">
                            {t('codexSync.confirm.description')}
                        </DialogDescription>
                    </DialogHeader>
                    <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => void onRestartCodexDesktop()}
                        disabled={isRestartingCodexDesktop}
                        aria-label={t('codexSync.restart.tooltip')}
                        title={t('codexSync.restart.tooltip')}
                    >
                        {/* 中文注释：把容易被误解为“刷新页面”的 icon 改成明确文字按钮，直接说明这是重启 Codex 客户端。 */}
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
