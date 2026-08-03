import { AttachmentPrimitive, useThreadComposerAttachment } from '@assistant-ui/react'
import type { PendingAttachment } from '@assistant-ui/react'
import { ImagePreview } from '@/components/ImagePreview'
import { Spinner } from '@/components/Spinner'
import { useComposerParking } from '@/components/AssistantChat/composerParkingContext'

type ComposerAttachmentWithPreview = PendingAttachment & {
    previewUrl?: string
}

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
    const { name, status, previewUrl } = useThreadComposerAttachment() as ComposerAttachmentWithPreview
    const isParking = useComposerParking()
    const isUploading = status.type === 'running'
    const isError = status.type === 'incomplete'

    if (previewUrl && !isError) {
        return (
            <AttachmentPrimitive.Root className="group relative h-16 w-24 overflow-hidden rounded-lg bg-[var(--app-subtle-bg)]">
                <ImagePreview
                    src={previewUrl}
                    fileName={name}
                    label={name}
                    galleryId="composer-attachments"
                    buttonClassName="group h-full w-full cursor-zoom-in overflow-hidden rounded-lg text-left"
                    imageClassName="h-full w-full object-cover transition-opacity group-hover:opacity-85"
                    caption={(
                        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-1.5 pb-1 pt-3">
                            <span className="block truncate text-[10px] leading-tight text-white">{name}</span>
                        </div>
                    )}
                />
                {isUploading ? (
                    <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/40">
                        <Spinner size="sm" label={null} className="text-white" />
                    </div>
                ) : null}
                {!isParking ? (
                    <AttachmentPrimitive.Remove
                        className="absolute right-1 top-1 z-10 flex h-6 w-6 items-center justify-center rounded-full bg-black/65 text-white transition-colors hover:bg-black/85 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-white"
                        aria-label="Remove attachment"
                        title="Remove attachment"
                    >
                        <RemoveIcon />
                    </AttachmentPrimitive.Remove>
                ) : null}
            </AttachmentPrimitive.Root>
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
            {!isParking ? (
                <AttachmentPrimitive.Remove
                    className="ml-auto flex h-5 w-5 items-center justify-center rounded text-[var(--app-hint)] transition-colors hover:text-[var(--app-fg)]"
                    aria-label="Remove attachment"
                    title="Remove attachment"
                >
                    <RemoveIcon />
                </AttachmentPrimitive.Remove>
            ) : null}
        </AttachmentPrimitive.Root>
    )
}
