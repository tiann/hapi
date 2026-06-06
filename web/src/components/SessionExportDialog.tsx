import { useEffect, useRef, useState } from 'react'
import type { ApiClient } from '@/api/client'
import type { Session } from '@/types/api'
import {
    downloadSessionExport,
    readSessionExportFormat,
    writeSessionExportFormat,
    type SessionExportFormat
} from '@/lib/sessionExport/download'
import { useToast } from '@/lib/toast-context'
import { useTranslation } from '@/lib/use-translation'
import { Button } from '@/components/ui/button'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle
} from '@/components/ui/dialog'

type SessionExportDialogProps = {
    isOpen: boolean
    onClose: () => void
    session: Session
    api: ApiClient | null
}

export function SessionExportDialog(props: SessionExportDialogProps) {
    const { t } = useTranslation()
    const toast = useToast()
    const [format, setFormat] = useState<SessionExportFormat>('json')
    const [isExporting, setIsExporting] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const abortRef = useRef<AbortController | null>(null)

    useEffect(() => {
        if (!props.isOpen) return
        setFormat(readSessionExportFormat())
        setError(null)
    }, [props.isOpen])

    useEffect(() => {
        return () => {
            abortRef.current?.abort()
        }
    }, [])

    const handleClose = () => {
        abortRef.current?.abort()
        abortRef.current = null
        setIsExporting(false)
        props.onClose()
    }

    const handleDownload = async () => {
        if (!props.api) {
            setError(t('session.export.error.noApi'))
            return
        }

        setError(null)
        setIsExporting(true)
        writeSessionExportFormat(format)
        const controller = new AbortController()
        abortRef.current = controller

        try {
            const result = await downloadSessionExport(props.api, props.session.id, format, {
                signal: controller.signal
            })
            toast.addToast({
                title: t('session.export.toast.success.title'),
                body: t('session.export.toast.success.body', { filename: result.filename }),
                sessionId: props.session.id,
                url: `/sessions/${props.session.id}`
            })
            props.onClose()
        } catch (error) {
            if (controller.signal.aborted) {
                return
            }
            const message = error instanceof Error && error.message
                ? error.message
                : t('session.export.error.default')
            setError(message)
            toast.addToast({
                title: t('session.export.toast.error.title'),
                body: message,
                sessionId: props.session.id,
                url: `/sessions/${props.session.id}`
            })
        } finally {
            if (abortRef.current === controller) {
                abortRef.current = null
            }
            if (!controller.signal.aborted) {
                setIsExporting(false)
            }
        }
    }

    return (
        <Dialog open={props.isOpen} onOpenChange={(open) => !open && handleClose()}>
            <DialogContent className="max-w-sm">
                <DialogHeader>
                    <DialogTitle>{t('session.export.title')}</DialogTitle>
                    <DialogDescription className="mt-2">
                        {t('session.export.description')}
                    </DialogDescription>
                </DialogHeader>

                <div className="mt-4 space-y-2">
                    <label className="flex cursor-pointer items-center gap-3 rounded-md border border-[var(--app-border)] p-3">
                        <input
                            type="radio"
                            name="session-export-format"
                            value="json"
                            checked={format === 'json'}
                            onChange={() => setFormat('json')}
                            disabled={isExporting}
                        />
                        <span>
                            <span className="block font-medium">{t('session.export.format.json')}</span>
                            <span className="block text-xs text-[var(--app-hint)]">{t('session.export.format.json.description')}</span>
                        </span>
                    </label>
                    <label className="flex cursor-pointer items-center gap-3 rounded-md border border-[var(--app-border)] p-3">
                        <input
                            type="radio"
                            name="session-export-format"
                            value="markdown"
                            checked={format === 'markdown'}
                            onChange={() => setFormat('markdown')}
                            disabled={isExporting}
                        />
                        <span>
                            <span className="block font-medium">{t('session.export.format.markdown')}</span>
                            <span className="block text-xs text-[var(--app-hint)]">{t('session.export.format.markdown.description')}</span>
                        </span>
                    </label>
                </div>

                {error ? (
                    <div className="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-400">
                        {error}
                    </div>
                ) : null}

                <div className="mt-4 flex justify-end gap-2">
                    <Button type="button" variant="secondary" onClick={handleClose} disabled={isExporting}>
                        {t('button.cancel')}
                    </Button>
                    <Button type="button" onClick={handleDownload} disabled={isExporting}>
                        {isExporting ? t('session.export.downloading') : t('session.export.download')}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    )
}
