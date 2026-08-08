import { useEffect, useState } from 'react'
import type { ClaudeLocalSessionSummary } from '@/types/api'
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

const CLAUDE_IMPORT_PICKER_LABELS = {
    selectedCount: 'claudeSync.confirm.selectedCount',
    selectAll: 'claudeSync.confirm.selectAll',
    clearAll: 'claudeSync.confirm.clearAll',
    cwdFilter: 'claudeSync.confirm.cwdFilter',
    cwdFilterAll: 'claudeSync.confirm.cwdFilterAll',
    cwd: 'claudeSync.confirm.cwd',
    current: 'claudeSync.confirm.current',
    loading: 'claudeSync.confirm.loading',
    empty: 'claudeSync.confirm.empty',
    emptyForWorkdir: 'claudeSync.confirm.emptyForWorkdir'
} as const

export function ClaudeSessionSyncDialog(props: {
    isOpen: boolean
    onClose: () => void
    sessions: ClaudeLocalSessionSummary[]
    currentClaudeSessionId: string | null
    onConfirm: (sessionIds: string[]) => Promise<void>
    isPending: boolean
    isLoading: boolean
}) {
    const { t } = useTranslation()
    const {
        isOpen,
        sessions,
        currentClaudeSessionId,
        onConfirm,
        isPending,
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

        // 中文注释：确认按钮只提交用户勾选的 Claude session，落库由父组件统一处理并给出 toast 提示。
        await onConfirm(selectedSessionIds)
    }

    return (
        <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-xl">
                <DialogHeader className="text-left">
                    <DialogTitle>{t('claudeSync.confirm.title')}</DialogTitle>
                    <DialogDescription className="mt-2">
                        {t('claudeSync.confirm.description')}
                    </DialogDescription>
                </DialogHeader>

                <SessionImportPicker
                    isOpen={isOpen}
                    sessions={sessions}
                    currentSessionId={currentClaudeSessionId}
                    selectedSessionIds={selectedSessionIds}
                    onSelectionChange={setSelectedSessionIds}
                    isPending={isPending}
                    isLoading={isLoading}
                    labels={CLAUDE_IMPORT_PICKER_LABELS}
                />

                <div className="mt-4 flex justify-end gap-2">
                    <Button
                        type="button"
                        variant="secondary"
                        onClick={onClose}
                        disabled={isPending}
                    >
                        {t('button.cancel')}
                    </Button>
                    <Button
                        type="button"
                        variant="secondary"
                        onClick={() => void handleConfirm()}
                        disabled={isPending || isLoading || selectedSessionIds.length === 0}
                    >
                        {isPending ? t('claudeSync.confirm.confirming') : t('claudeSync.confirm.confirm')}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    )
}
