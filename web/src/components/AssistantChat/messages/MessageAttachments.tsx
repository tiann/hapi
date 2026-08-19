import { useEffect, useRef, useState } from 'react'
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
    const [thumbnailUrl, setThumbnailUrl] = useState(attachment.previewUrl ?? '')
    const [previewFailed, setPreviewFailed] = useState(false)
    const [originalLoading, setOriginalLoading] = useState(false)
    const [originalFailed, setOriginalFailed] = useState(false)
    const thumbnailUrlRef = useRef<string | undefined>(undefined)
    const originalUrlRef = useRef<string | undefined>(undefined)
    const lifecycleRef = useRef(0)

    useEffect(() => {
        lifecycleRef.current += 1
        let cancelled = false
        setThumbnailUrl(attachment.previewUrl ?? '')
        setPreviewFailed(false)
        setOriginalLoading(false)
        setOriginalFailed(false)
        const attachmentId = attachment.attachmentId
        if (attachmentId && !attachment.previewUrl) {
            void (async () => {
                try {
                    const blob = await props.api.fetchAttachmentBlob(props.sessionId, attachmentId, 'thumbnail')
                    if (cancelled) return
                    const url = URL.createObjectURL(blob)
                    thumbnailUrlRef.current = url
                    setThumbnailUrl(url)
                } catch {
                    if (!cancelled) setPreviewFailed(true)
                }
            })()
        }
        return () => {
            cancelled = true
            lifecycleRef.current += 1
            if (thumbnailUrlRef.current) URL.revokeObjectURL(thumbnailUrlRef.current)
            if (originalUrlRef.current) URL.revokeObjectURL(originalUrlRef.current)
            thumbnailUrlRef.current = undefined
            originalUrlRef.current = undefined
        }
    }, [attachment.attachmentId, attachment.previewUrl, props.api, props.sessionId])

    const openOriginal = async (): Promise<string | undefined> => {
        if (!attachment.attachmentId) return undefined
        if (originalUrlRef.current) return originalUrlRef.current
        const lifecycle = lifecycleRef.current
        try {
            const blob = await props.api.fetchAttachmentBlob(props.sessionId, attachment.attachmentId, 'original')
            if (lifecycle !== lifecycleRef.current) return undefined
            const url = URL.createObjectURL(blob)
            if (lifecycle !== lifecycleRef.current) {
                URL.revokeObjectURL(url)
                return undefined
            }
            originalUrlRef.current = url
            return url
        } catch {
            return undefined
        }
    }

    const loadOriginalFromCard = async () => {
        if (originalLoading) return
        setOriginalLoading(true)
        setOriginalFailed(false)
        const lifecycle = lifecycleRef.current
        const url = await openOriginal()
        if (lifecycle !== lifecycleRef.current) return
        if (url) {
            setThumbnailUrl(url)
            setPreviewFailed(false)
        } else {
            setOriginalFailed(true)
        }
        setOriginalLoading(false)
    }

    if (previewFailed) {
        return (
            <FileAttachment
                attachment={attachment}
                onClick={attachment.attachmentId ? loadOriginalFromCard : undefined}
                actionLabel={originalLoading
                    ? t('image.original.loading')
                    : originalFailed
                        ? t('image.original.retry')
                        : t('image.original.load')}
                disabled={originalLoading}
            />
        )
    }

    if (!thumbnailUrl) {
        return (
            <div className="flex h-32 w-48 items-center justify-center rounded-lg bg-[var(--app-bg)] text-xs text-[var(--app-hint)]">
                Loading preview…
            </div>
        )
    }

    return (
        <ImagePreview
            src={thumbnailUrl}
            fileName={attachment.filename}
            label={attachment.filename}
            onOpen={attachment.attachmentId ? openOriginal : undefined}
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
    disabled?: boolean
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
            className={`${className} w-full hover:bg-[var(--app-subtle-bg)] disabled:cursor-wait disabled:opacity-70`}
            onClick={() => { void props.onClick?.() }}
            disabled={props.disabled}
            title={props.actionLabel}
        >
            {content}
        </button>
    )
}

export function MessageAttachments(props: { attachments: AttachmentMetadata[]; api: ApiClient; sessionId: string }) {
    const { attachments, api, sessionId } = props
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
                        <FileAttachment key={attachment.id} attachment={attachment} />
                    ))}
                </div>
            )}
        </div>
    )
}
