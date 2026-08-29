import { useCallback, useEffect, useState } from 'react'
import type { AttachmentMetadata } from '@/types/api'
import type { ApiClient } from '@/api/client'
import { FileIcon } from '@/components/FileIcon'
import { isImageMimeType } from '@/lib/fileAttachments'
import { ImagePreview } from '@/components/ImagePreview'
import { useTranslation } from '@/lib/use-translation'

function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function ImageAttachment(props: { attachment: AttachmentMetadata; api: ApiClient; sessionId: string }) {
    const { attachment } = props
    const { t } = useTranslation()
    const [source, setSource] = useState(attachment.previewUrl ?? '')
    const [loading, setLoading] = useState(Boolean(attachment.attachmentId && !attachment.previewUrl))
    const [failed, setFailed] = useState(false)

    const loadOriginal = useCallback(async (): Promise<string | undefined> => {
        if (!attachment.attachmentId) return undefined
        const blob = await props.api.fetchAttachmentBlob(props.sessionId, attachment.attachmentId)
        return URL.createObjectURL(blob)
    }, [attachment.attachmentId, props.api, props.sessionId])

    useEffect(() => {
        let cancelled = false
        let objectUrl: string | undefined
        setSource(attachment.previewUrl ?? '')
        setFailed(false)
        if (!attachment.attachmentId || attachment.previewUrl) {
            setLoading(false)
            return
        }

        setLoading(true)
        void loadOriginal()
            .then((url) => {
                if (cancelled) {
                    if (url) URL.revokeObjectURL(url)
                    return
                }
                if (!url) {
                    setFailed(true)
                    return
                }
                objectUrl = url
                setSource(url)
            })
            .catch(() => {
                if (!cancelled) setFailed(true)
            })
            .finally(() => {
                if (!cancelled) setLoading(false)
            })

        return () => {
            cancelled = true
            if (objectUrl) URL.revokeObjectURL(objectUrl)
        }
    }, [attachment.attachmentId, attachment.previewUrl, loadOriginal])

    const downloadOriginal = async () => {
        const url = await loadOriginal()
        if (!url) return
        const link = document.createElement('a')
        link.href = url
        link.download = attachment.filename
        link.click()
        window.setTimeout(() => URL.revokeObjectURL(url), 0)
    }

    if (loading) {
        return (
            <div className="flex h-32 w-48 items-center justify-center rounded-lg bg-[var(--app-bg)] text-xs text-[var(--app-hint)]">
                {t('loading')}
            </div>
        )
    }

    if (failed || !source) {
        return (
            <FileAttachment
                attachment={attachment}
                onClick={attachment.attachmentId ? downloadOriginal : undefined}
                actionLabel={attachment.attachmentId ? t('files.directories.download') : undefined}
            />
        )
    }

    return (
        <ImagePreview
            src={source}
            fileName={attachment.filename}
            label={attachment.filename}
            buttonClassName="relative overflow-hidden rounded-lg text-left cursor-zoom-in"
            imageClassName="max-h-48 max-w-full object-contain"
            caption={(
                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent px-2 py-1.5">
                    <span className="text-xs text-white/90 line-clamp-1">
                        {attachment.filename}
                    </span>
                </div>
            )}
        />
    )
}

function FileAttachment(props: {
    attachment: AttachmentMetadata
    onClick?: () => void | Promise<void>
    actionLabel?: string
}) {
    const { attachment } = props
    const content = (
        <>
            <FileIcon fileName={attachment.filename} size={24} />
            <div className="min-w-0 flex-1">
                <div className="truncate text-base font-medium text-[var(--app-fg)]">
                    {attachment.filename}
                </div>
                <div className="text-xs text-[var(--app-hint)]">
                    {formatFileSize(attachment.size)}
                </div>
                {props.actionLabel ? (
                    <div className="text-xs text-[var(--app-hint)]">
                        {props.actionLabel}
                    </div>
                ) : null}
            </div>
        </>
    )
    const className = 'flex items-center gap-2 rounded-lg bg-[var(--app-bg)] px-3 py-2 text-left'
    if (!props.onClick) return <div className={className}>{content}</div>
    return (
        <button
            type="button"
            className={`${className} w-full hover:bg-[var(--app-subtle-bg)]`}
            onClick={() => { void props.onClick?.() }}
            title={props.actionLabel}
        >
            {content}
        </button>
    )
}

export function MessageAttachments(props: { attachments: AttachmentMetadata[]; api: ApiClient; sessionId: string }) {
    const { attachments, api, sessionId } = props
    const { t } = useTranslation()
    if (!attachments || attachments.length === 0) return null

    const images = attachments.filter(a => isImageMimeType(a.mimeType) && (a.previewUrl || a.attachmentId))
    const files = attachments.filter(a => !isImageMimeType(a.mimeType) || (!a.previewUrl && !a.attachmentId))

    return (
        <div className="mt-2 flex flex-col gap-2">
            {images.length > 0 && (
                <div
                    className="hapi-share-media-grid flex flex-wrap gap-2"
                    data-hapi-image-count={images.length}
                >
                    {images.map(attachment => (
                        <ImageAttachment key={attachment.id} attachment={attachment} api={api} sessionId={sessionId} />
                    ))}
                </div>
            )}
            {files.length > 0 && (
                <div className="flex flex-col gap-1.5">
                    {files.map(attachment => (
                        <FileAttachment
                            key={attachment.id}
                            attachment={attachment}
                            onClick={attachment.attachmentId
                                ? async () => {
                                    const blob = await api.fetchAttachmentBlob(sessionId, attachment.attachmentId!)
                                    const url = URL.createObjectURL(blob)
                                    const link = document.createElement('a')
                                    link.href = url
                                    link.download = attachment.filename
                                    link.click()
                                    window.setTimeout(() => URL.revokeObjectURL(url), 0)
                                }
                                : undefined}
                            actionLabel={attachment.attachmentId ? t('files.directories.download') : undefined}
                        />
                    ))}
                </div>
            )}
        </div>
    )
}
