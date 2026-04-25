import { useState } from 'react'
import { AttachmentPrimitive, useThreadComposerAttachment } from '@assistant-ui/react'
import { Spinner } from '@/components/Spinner'
import { ImageLightbox } from '@/components/ImageLightbox'

function ErrorIcon() {
    return (
        <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
            <path d="M8 5v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <circle cx="8" cy="11" r="0.75" fill="currentColor" />
        </svg>
    )
}

function RemoveIcon() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <line x1="3" y1="3" x2="9" y2="9" />
            <line x1="9" y1="3" x2="3" y2="9" />
        </svg>
    )
}

export function AttachmentItem() {
    const attachment = useThreadComposerAttachment()
    const { name, status } = attachment
    const isUploading = status.type === 'running'
    const isError = status.type === 'incomplete'
    const [lightboxOpen, setLightboxOpen] = useState(false)

    const previewUrl = (attachment as Record<string, unknown>).previewUrl as string | undefined
    const isImage = typeof previewUrl === 'string' && previewUrl.length > 0

    if (isImage && !isError) {
        return (
            <>
                <AttachmentPrimitive.Root className="group relative overflow-hidden rounded-lg">
                    <img
                        src={previewUrl}
                        alt={name}
                        className="h-16 max-w-[120px] cursor-pointer rounded-lg object-cover transition-opacity hover:opacity-80"
                        onClick={() => setLightboxOpen(true)}
                    />
                    {isUploading && (
                        <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/40">
                            <Spinner size="sm" label={null} className="text-white" />
                        </div>
                    )}
                    <AttachmentPrimitive.Remove
                        className="absolute -right-1 -top-1 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-white/80 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-black/80 hover:text-white"
                        aria-label="Remove attachment"
                        title="Remove attachment"
                    >
                        <RemoveIcon />
                    </AttachmentPrimitive.Remove>
                    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent px-1.5 py-1">
                        <span className="text-[10px] leading-tight text-white/90 line-clamp-1">{name}</span>
                    </div>
                </AttachmentPrimitive.Root>
                <ImageLightbox src={previewUrl} alt={name} open={lightboxOpen} onClose={() => setLightboxOpen(false)} />
            </>
        )
    }

    return (
        <AttachmentPrimitive.Root className="flex items-center gap-2 rounded-lg bg-[var(--app-subtle-bg)] px-3 py-2 text-base text-[var(--app-fg)]">
            {isUploading ? <Spinner size="sm" label={null} className="text-[var(--app-hint)]" /> : null}
            {isError ? (
                <span className="text-red-500">
                    <ErrorIcon />
                </span>
            ) : null}
            <span className={`max-w-[150px] truncate ${isError ? 'text-red-500 line-through' : ''}`}>{name}</span>
            {isError ? <span className="text-xs text-red-500 whitespace-nowrap">Upload failed</span> : null}
            <AttachmentPrimitive.Remove
                className="ml-auto flex h-5 w-5 items-center justify-center rounded text-[var(--app-hint)] transition-colors hover:text-[var(--app-fg)]"
                aria-label="Remove attachment"
                title="Remove attachment"
            >
                <RemoveIcon />
            </AttachmentPrimitive.Remove>
        </AttachmentPrimitive.Root>
    )
}
