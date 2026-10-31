import type { AttachmentMetadata } from '@/types/api'
import { FileIcon } from '@/components/FileIcon'
import { isImageMimeType } from '@/lib/fileAttachments'
import { ImagePreview } from '@/components/ImagePreview'

function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function ImageAttachment(props: { attachment: AttachmentMetadata }) {
    const { attachment } = props
    return (
        <ImagePreview
            src={attachment.previewUrl ?? ''}
            fileName={attachment.filename}
            label={attachment.filename}
            fileSize={attachment.size}
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

    const groups: { images: boolean; attachments: AttachmentMetadata[] }[] = []
    for (const attachment of attachments) {
        const images = Boolean(isImageMimeType(attachment.mimeType) && attachment.previewUrl)
        const previous = groups.at(-1)
        if (previous?.images === images) previous.attachments.push(attachment)
        else groups.push({ images, attachments: [attachment] })
    }

    return (
        <div className="mt-2 flex flex-col gap-2">
            {groups.map((group) => (
                <div key={group.attachments[0]!.id}
                    className={group.images ? 'hapi-share-media-grid flex flex-wrap gap-2' : 'flex flex-col gap-1.5'}
                    data-hapi-image-count={group.images ? group.attachments.length : undefined}>
                    {group.attachments.map(attachment => group.images
                        ? <ImageAttachment key={attachment.id} attachment={attachment} />
                        : <FileAttachment key={attachment.id} attachment={attachment} />)}
                </div>
            ))}
        </div>
    )
}
