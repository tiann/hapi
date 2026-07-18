import { type ReactNode, useEffect, useState } from 'react'
import type { AttachmentMetadata } from '@/types/api'
import { FileIcon } from '@/components/FileIcon'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { getSafeAttachmentPreviewUrl } from '@/lib/safeAttachmentPreviewUrl'

const RENDERABLE_IMAGE_MIME_TYPES = new Set([
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'image/avif'
])

function isRenderableImageMimeType(mimeType: string): boolean {
    return RENDERABLE_IMAGE_MIME_TYPES.has(mimeType.toLowerCase())
}

function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function dataUrlToBlob(dataUrl: string, fallbackMimeType: string): Blob | null {
    const match = /^data:([^;,]+);base64,([\s\S]*)$/i.exec(dataUrl)
    if (!match) return null

    const mimeType = match[1] || fallbackMimeType || 'application/octet-stream'
    const payload = match[2] ?? ''

    try {
        const binary = atob(payload)
        const bytes = new Uint8Array(binary.length)
        for (let index = 0; index < binary.length; index += 1) {
            bytes[index] = binary.charCodeAt(index)
        }
        return new Blob([bytes], { type: mimeType })
    } catch {
        return null
    }
}

function useAttachmentActionUrl(attachment: AttachmentMetadata): string | undefined {
    const [objectUrl, setObjectUrl] = useState<string | undefined>()
    const previewUrl = attachment.previewUrl

    useEffect(() => {
        setObjectUrl(undefined)

        if (!previewUrl?.startsWith('data:')) return
        if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return

        const blob = dataUrlToBlob(previewUrl, attachment.mimeType)
        if (!blob) return

        const nextObjectUrl = URL.createObjectURL(blob)
        setObjectUrl(nextObjectUrl)

        return () => {
            if (typeof URL.revokeObjectURL === 'function') {
                URL.revokeObjectURL(nextObjectUrl)
            }
        }
    }, [attachment.mimeType, previewUrl])

    return objectUrl ?? previewUrl
}

function AttachmentActionsDialog(props: { attachment: AttachmentMetadata; children: ReactNode }) {
    const { attachment, children } = props
    const actionUrl = useAttachmentActionUrl(attachment)

    return (
        <Dialog>
            <DialogTrigger asChild>
                {children}
            </DialogTrigger>
            <DialogContent className="max-w-sm">
                <DialogHeader>
                    <DialogTitle className="break-all">{attachment.filename}</DialogTitle>
                    <DialogDescription>
                        Open or download this attachment. On iPhone, use Open first, then the system share menu to save.
                    </DialogDescription>
                </DialogHeader>
                <div className="mt-3 rounded-lg bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-hint)]">
                    <div>{formatFileSize(attachment.size)}</div>
                    <div className="break-all">{attachment.mimeType}</div>
                </div>
                {actionUrl ? (
                    <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <a
                            href={actionUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label={`Open ${attachment.filename}`}
                            className="inline-flex h-10 items-center justify-center rounded-lg bg-[var(--app-subtle-bg)] px-3 text-sm font-semibold text-[var(--app-fg)]"
                        >
                            Open
                        </a>
                        <a
                            href={actionUrl}
                            download={attachment.filename}
                            aria-label={`Download ${attachment.filename}`}
                            className="inline-flex h-10 items-center justify-center rounded-lg bg-[var(--app-button)] px-3 text-sm font-semibold text-[var(--app-button-text)]"
                        >
                            Download
                        </a>
                    </div>
                ) : (
                    <div className="mt-4 text-sm text-[var(--app-hint)]">
                        This attachment is unavailable for download.
                    </div>
                )}
            </DialogContent>
        </Dialog>
    )
}

function ImageAttachment(props: { attachment: AttachmentMetadata }) {
    const { attachment } = props
    const [failed, setFailed] = useState(false)
    if (failed) return <FileAttachment attachment={attachment} />

    const image = (
        <div className="relative overflow-hidden rounded-lg">
            <img
                src={attachment.previewUrl}
                alt={attachment.filename}
                className="max-h-48 max-w-full object-contain"
                onError={() => setFailed(true)}
            />
            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent px-2 py-1.5">
                <span className="text-xs text-white/90 line-clamp-1">
                    {attachment.filename}
                </span>
            </div>
        </div>
    )

    return attachment.previewUrl ? (
        <a
            href={attachment.previewUrl}
            download={attachment.filename}
            aria-label={`Download ${attachment.filename}`}
            className="block"
        >
            {image}
        </a>
    ) : image
}

function FileAttachment(props: { attachment: AttachmentMetadata }) {
    const { attachment } = props
    const card = (
        <div className="flex items-center gap-2 rounded-lg bg-[var(--app-bg)] px-3 py-2">
            <FileIcon fileName={attachment.filename} size={24} />
            <div className="min-w-0 flex-1">
                <div className="truncate text-base font-medium text-[var(--app-fg)]">
                    {attachment.filename}
                </div>
                <div className="text-xs text-[var(--app-hint)]">
                    {formatFileSize(attachment.size)}
                </div>
            </div>
        </div>
    )

    return attachment.previewUrl ? (
        <AttachmentActionsDialog attachment={attachment}>
            <button
                type="button"
                aria-label={`Open attachment actions for ${attachment.filename}`}
                className="block w-full rounded-lg text-left focus:outline-none focus:ring-2 focus:ring-[var(--app-accent)]"
            >
                {card}
            </button>
        </AttachmentActionsDialog>
    ) : (
        <div
            className="block rounded-lg"
        >
            {card}
        </div>
    )
}

export function MessageAttachments(props: { attachments: AttachmentMetadata[] }) {
    const { attachments } = props
    if (!attachments || attachments.length === 0) return null

    const safeAttachments = attachments.map((attachment) => ({
        ...attachment,
        previewUrl: getSafeAttachmentPreviewUrl(attachment.previewUrl, attachment.mimeType)
    }))
    const images = safeAttachments.filter(a => isRenderableImageMimeType(a.mimeType) && a.previewUrl)
    const files = safeAttachments.filter(a => !isRenderableImageMimeType(a.mimeType) || !a.previewUrl)

    return (
        <div className="mt-2 flex flex-col gap-2">
            {images.length > 0 && (
                <div className="flex flex-wrap gap-2">
                    {images.map(attachment => (
                        <ImageAttachment key={attachment.id} attachment={attachment} />
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
