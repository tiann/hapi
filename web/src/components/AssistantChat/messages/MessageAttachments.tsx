import type { AttachmentMetadata } from '@/types/api'
import { FileIcon } from '@/components/FileIcon'
import { ChatImage } from '@/components/ui/ChatImage'
import { isImageMimeType } from '@/lib/fileAttachments'

function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function ImageAttachment(props: { attachment: AttachmentMetadata & { previewUrl: string } }) {
    const { attachment } = props
    return (
        <div className="relative overflow-hidden rounded-lg">
            <ChatImage
                src={attachment.previewUrl}
                alt={attachment.filename}
                maxHeight={192}
            />
            <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent px-2 py-1.5">
                <span className="text-xs text-white/90 line-clamp-1">
                    {attachment.filename}
                </span>
            </div>
        </div>
    )
}

function FileAttachment(props: { attachment: AttachmentMetadata }) {
    const { attachment } = props
    return (
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
}

export function MessageAttachments(props: { attachments: AttachmentMetadata[] }) {
    const { attachments } = props
    if (!attachments || attachments.length === 0) return null

    const images = attachments.filter(
        (a): a is AttachmentMetadata & { previewUrl: string } =>
            isImageMimeType(a.mimeType) && typeof a.previewUrl === 'string' && a.previewUrl.length > 0
    )
    const files = attachments.filter(a => !isImageMimeType(a.mimeType) || !a.previewUrl)

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
