import { useCallback } from 'react'
import { useAssistantApi } from '@assistant-ui/react'
import { useDragOver } from '@/hooks/useDragOver'
import { useTranslation } from '@/lib/use-translation'

export function DragDropZone({
    children,
    disabled,
}: {
    children: React.ReactNode
    disabled?: boolean
}) {
    const api = useAssistantApi()
    const isDragging = useDragOver()
    const { t } = useTranslation()

    const onDragOver = useCallback((e: React.DragEvent) => {
        if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'copy'
        }
    }, [])

    const onDrop = useCallback(
        async (e: React.DragEvent) => {
            e.preventDefault()
            if (disabled) return
            const files = Array.from(e.dataTransfer.files)
            if (files.length === 0) return
            try {
                for (const file of files) {
                    await api.composer().addAttachment(file)
                }
            } catch (error) {
                console.error('Error adding dragged file:', error)
            }
        },
        [api, disabled]
    )

    return (
        <div
            className="relative flex min-h-0 flex-1 flex-col"
            onDragOver={onDragOver}
            onDrop={onDrop}
        >
            {children}
            {isDragging && (
                <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center rounded-lg border-2 border-dashed border-[var(--app-link)] bg-[var(--app-link)]/10">
                    <div className="rounded-lg bg-[var(--app-bg)] px-4 py-2 text-sm font-medium text-[var(--app-link)] shadow-lg">
                        {t('composer.dropToAttach')}
                    </div>
                </div>
            )}
        </div>
    )
}
