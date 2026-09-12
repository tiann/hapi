import { AttachmentPrimitive, useThreadComposerAttachment } from '@assistant-ui/react'
import type { PendingAttachment } from '@assistant-ui/react'
import type { KeyboardEventHandler, MouseEventHandler, PointerEventHandler, PointerEvent as ReactPointerEvent } from 'react'
import { ImagePreview } from '@/components/ImagePreview'
import { Spinner } from '@/components/Spinner'
import { useComposerParking } from '@/components/AssistantChat/composerParkingContext'

type ComposerAttachmentWithPreview = PendingAttachment & {
    previewUrl?: string
}

export type AttachmentDragHandleProps = {
    onPointerDown: PointerEventHandler<HTMLButtonElement>
    onKeyDown: KeyboardEventHandler<HTMLButtonElement>
    ariaLabel: string
    title: string
    onSurfacePointerDown?: PointerEventHandler<HTMLElement>
    onSurfaceContextMenu?: MouseEventHandler<HTMLElement>
    onSurfaceClick?: MouseEventHandler<HTMLElement>
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

function DragHandleIcon() {
    return (
        <svg
            aria-hidden="true"
            xmlns="http://www.w3.org/2000/svg"
            width="12"
            height="12"
            viewBox="0 0 14 14"
            fill="currentColor"
        >
            <circle cx="4" cy="3" r="1" />
            <circle cx="10" cy="3" r="1" />
            <circle cx="4" cy="7" r="1" />
            <circle cx="10" cy="7" r="1" />
            <circle cx="4" cy="11" r="1" />
            <circle cx="10" cy="11" r="1" />
        </svg>
    )
}

function DragHandle(props: AttachmentDragHandleProps & { isFile?: boolean }) {
    const isFile = props.isFile === true

    return (
        <button
            type="button"
            data-testid="attachment-drag-handle"
            aria-label={props.ariaLabel}
            title={props.title}
            onPointerDown={props.onPointerDown}
            onKeyDown={props.onKeyDown}
            className={isFile
                ? 'hapi-composer-attachment-control hapi-composer-attachment-file-control -mx-1 flex h-6 w-6 shrink-0 touch-none cursor-grab items-center justify-center rounded-md bg-transparent text-[var(--app-hint)] transition-colors hover:text-[var(--app-fg)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--app-link)] active:cursor-grabbing'
                : 'hapi-composer-attachment-control absolute left-1 top-1 z-20 flex h-8 w-8 touch-none cursor-grab items-start justify-start rounded-md bg-transparent text-white/90 transition-colors hover:bg-black/15 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--app-link)] active:cursor-grabbing'}
        >
            {isFile ? (
                <DragHandleIcon />
            ) : (
                <span className="flex h-5 w-5 items-center justify-center rounded bg-black/40 shadow-sm ring-1 ring-white/20">
                    <DragHandleIcon />
                </span>
            )}
        </button>
    )
}

export function AttachmentItem(props: { dragHandleProps?: AttachmentDragHandleProps } = {}) {
    const { name, status, previewUrl } = useThreadComposerAttachment() as ComposerAttachmentWithPreview
    const isParking = useComposerParking()
    const isUploading = status.type === 'running'
    const isError = status.type === 'incomplete'
    const surfacePointerDown = props.dragHandleProps?.onSurfacePointerDown
        ? (event: ReactPointerEvent<HTMLElement>) => {
            const target = event.target
            if (target instanceof Element && target.closest('button, a, input, textarea, select, [role="button"]')) {
                return
            }
            props.dragHandleProps?.onSurfacePointerDown?.(event)
        }
        : undefined

    if (previewUrl && !isError) {
        return (
            <AttachmentPrimitive.Root
                className="group relative h-16 w-24 overflow-hidden rounded-lg bg-[var(--app-subtle-bg)]"
                onPointerDown={surfacePointerDown}
                onContextMenu={props.dragHandleProps?.onSurfaceContextMenu}
            >
                <ImagePreview
                    src={previewUrl}
                    fileName={name}
                    label={name}
                    galleryId="composer-attachments"
                    buttonClassName={`group h-full w-full cursor-zoom-in overflow-hidden rounded-lg text-left ${props.dragHandleProps ? 'touch-none' : ''}`}
                    imageClassName="h-full w-full object-cover"
                    onTriggerPointerDown={props.dragHandleProps?.onSurfacePointerDown}
                    onTriggerContextMenu={props.dragHandleProps?.onSurfaceContextMenu}
                    onTriggerClick={props.dragHandleProps?.onSurfaceClick}
                    caption={(
                        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-1.5 pb-1 pt-3">
                            <span className="block truncate text-[10px] leading-tight text-white">{name}</span>
                        </div>
                    )}
                />
                {props.dragHandleProps ? (
                    <DragHandle {...props.dragHandleProps} />
                ) : null}
                {isUploading ? (
                    <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/40">
                        <Spinner size="sm" label={null} className="text-white" />
                    </div>
                ) : null}
                {!isParking ? (
                    <AttachmentPrimitive.Remove
                        className="hapi-composer-attachment-control absolute right-1 top-1 z-20 flex h-8 w-8 items-start justify-end rounded-md bg-transparent text-white transition-colors hover:bg-black/15 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-white"
                        aria-label="Remove attachment"
                        title="Remove attachment"
                    >
                        <span className="flex h-5 w-5 items-center justify-center rounded-md bg-black/40 shadow-sm ring-1 ring-white/20">
                            <RemoveIcon />
                        </span>
                    </AttachmentPrimitive.Remove>
                ) : null}
            </AttachmentPrimitive.Root>
        )
    }

    return (
        <AttachmentPrimitive.Root
            className="relative flex items-center gap-1.5 rounded-lg bg-[var(--app-subtle-bg)] px-2 py-2 text-base text-[var(--app-fg)]"
            onPointerDown={surfacePointerDown}
            onContextMenu={props.dragHandleProps?.onSurfaceContextMenu}
        >
            {props.dragHandleProps ? <DragHandle {...props.dragHandleProps} isFile /> : null}
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
                    className="hapi-composer-attachment-control hapi-composer-attachment-file-control -mx-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-transparent text-[var(--app-hint)] transition-colors hover:text-[var(--app-fg)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--app-link)]"
                    aria-label="Remove attachment"
                    title="Remove attachment"
                >
                    <RemoveIcon />
                </AttachmentPrimitive.Remove>
            ) : null}
        </AttachmentPrimitive.Root>
    )
}
