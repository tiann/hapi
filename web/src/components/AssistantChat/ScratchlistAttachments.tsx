import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react'
import type { ApiClient } from '@/api/client'
import type { ScratchlistAttachmentWithPreview } from '@/lib/scratchlistAttachmentPreview'
import {
    getScratchlistAttachmentPreview, rememberScratchlistAttachmentPreview,
    rememberScratchlistAttachmentObjectUrl, retainScratchlistAttachmentPreview,
} from '@/lib/scratchlistAttachmentPreview'
import { isImageMimeType } from '@/lib/fileAttachments'
import { moveAttachmentId, orderItemsById } from '@/lib/attachmentOrder'
import { ImagePreview } from '@/components/ImagePreview'
import { PlusIcon } from '@/components/icons'

function RemoveIcon() {
    return <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <path d="m3 3 6 6M9 3 3 9" />
    </svg>
}

function DragIcon() {
    return <svg width="12" height="12" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
        {[3, 7, 11].flatMap((cy) => [4, 10].map((cx) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="1" />))}
    </svg>
}

type Props = {
    attachments: ScratchlistAttachmentWithPreview[]
    sessionId?: string
    api?: ApiClient
    disabled?: boolean
    onRemove: (id: string) => void
    onReorder: (ids: string[]) => void | Promise<void>
    onAdd?: () => void
    addLabel?: string
}

type Drag = { id: string; pointerId: number; x: number; y: number; started: boolean; order: string[] }

export function ScratchlistAttachments(props: Props) {
    const imageAttachments = useMemo(() => props.attachments.filter((a) => isImageMimeType(a.mimeType)), [props.attachments])
    const imageKey = imageAttachments.map((a) => [a.id, a.filename, a.mimeType, a.size, a.path, a.previewUrl ?? ''].join('\u001f')).join('\u001e')
    const [, setPreviewRevision] = useState(0)
    const latest = useRef(props)
    latest.current = props
    useEffect(() => {
        const attachments = latest.current.attachments.filter((a) => isImageMimeType(a.mimeType))
        const releases = attachments.map((a) => retainScratchlistAttachmentPreview(a.id))
        for (const attachment of attachments) rememberScratchlistAttachmentPreview(attachment, attachment.previewUrl)
        let cancelled = false
        void Promise.all(attachments.filter((a) => !getScratchlistAttachmentPreview(a)).map(async (attachment) => {
            if (!props.api || !props.sessionId) return
            // An optimistic attachment may not be persisted yet (GET 404).
            // Retry a couple of times so the preview appears once Hub has it,
            // without hiding the file or its actions on transient failures.
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    const blob = await props.api.fetchScratchlistAttachmentBlob(props.sessionId, attachment.id)
                    rememberScratchlistAttachmentObjectUrl(attachment, URL.createObjectURL(blob))
                    return
                } catch {
                    if (cancelled) return
                    await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)))
                }
            }
        })).then(() => { if (!cancelled) setPreviewRevision((value) => value + 1) })
        return () => { cancelled = true; releases.forEach((release) => release()) }
    }, [imageKey, props.api, props.sessionId])

    const [order, setOrder] = useState<string[] | null>(null)
    const [draggingId, setDraggingId] = useState<string | null>(null)
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const savingRef = useRef(false)
    const drag = useRef<Drag | null>(null)
    const container = useRef<HTMLDivElement>(null)
    const suppressClick = useRef<string | null>(null)
    const suppressionTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
    const attachmentKey = props.attachments.map((a) => a.id).join('\u001f')
    const canReorder = props.attachments.length > 1 && !props.disabled
    const attachments = order ? orderItemsById(props.attachments, order) : props.attachments

    const saveOrder = useCallback(async (ids: string[]) => {
        if (latest.current.disabled || savingRef.current) { setOrder(null); return }
        const current = latest.current.attachments.map((a) => a.id)
        if (ids.join('\u001f') === current.join('\u001f')) { setOrder(null); return }
        savingRef.current = true
        setSaving(true)
        setError(null)
        try {
            await latest.current.onReorder(ids)
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
            savingRef.current = false
            setSaving(false)
            setOrder(null)
        }
    }, [])

    useEffect(() => {
        // Remote attachment changes invalidate an unfinished gesture.
        drag.current = null
        setDraggingId(null)
        setOrder(null)
    }, [attachmentKey, props.disabled])

    useEffect(() => {
        const element = container.current
        if (!element) return
        let gesture: { x: number; y: number; scrollLeft: number; dragging: boolean } | null = null
        const cancel = () => { gesture = null }
        const start = (event: TouchEvent) => {
            gesture = null
            if (event.touches.length !== 1) return
            const target = event.target
            if (target instanceof Element && target.closest('[data-scratchlist-action="reorder-attachment"]')) return
            const touch = event.touches[0]!
            gesture = { x: touch.clientX, y: touch.clientY, scrollLeft: element.scrollLeft, dragging: false }
        }
        const move = (event: TouchEvent) => {
            if (!gesture || event.touches.length !== 1) return
            const touch = event.touches[0]!
            const dx = touch.clientX - gesture.x
            const dy = touch.clientY - gesture.y
            if (!gesture.dragging) {
                if (Math.max(Math.abs(dx), Math.abs(dy)) < 8) return
                if (Math.abs(dy) >= Math.abs(dx) || element.scrollWidth <= element.clientWidth) {
                    cancel()
                    return
                }
                gesture.dragging = true
            }
            if (event.cancelable) {
                event.preventDefault()
                element.scrollLeft = gesture.scrollLeft - dx
            }
        }
        const end = (event: TouchEvent) => {
            if (gesture?.dragging && event.cancelable) event.preventDefault()
            cancel()
        }
        element.addEventListener('touchstart', start, { passive: true })
        // React delegates touchmove passively. This local listener prevents
        // horizontal swipes from opening the thumbnail while vertical swipes
        // continue to scroll the drawer.
        element.addEventListener('touchmove', move, { passive: false })
        element.addEventListener('touchend', end, { passive: false })
        element.addEventListener('touchcancel', cancel)
        return () => {
            element.removeEventListener('touchstart', start)
            element.removeEventListener('touchmove', move)
            element.removeEventListener('touchend', end)
            element.removeEventListener('touchcancel', cancel)
        }
    }, [])

    useEffect(() => {
        const move = (event: PointerEvent) => {
            const active = drag.current
            if (!active || active.pointerId !== event.pointerId) return
            if (!active.started && Math.hypot(event.clientX - active.x, event.clientY - active.y) < 6) return
            active.started = true
            event.preventDefault()
            setDraggingId(active.id)
            for (const element of document.elementsFromPoint(event.clientX, event.clientY)) {
                const target = element.closest<HTMLElement>('[data-scratchlist-attachment-id]')
                if (!target || !container.current?.contains(target)) continue
                const id = target.dataset.scratchlistAttachmentId!
                if (id !== active.id) {
                    const rect = target.getBoundingClientRect()
                    active.order = moveAttachmentId(active.order, active.id, id, event.clientX >= rect.left + rect.width / 2 ? 'after' : 'before')
                    setOrder(active.order)
                }
                break
            }
        }
        const finish = (event: PointerEvent) => {
            const active = drag.current
            if (!active || active.pointerId !== event.pointerId) return
            drag.current = null
            setDraggingId(null)
            if (active.started) {
                suppressClick.current = active.id
                if (suppressionTimer.current) clearTimeout(suppressionTimer.current)
                suppressionTimer.current = setTimeout(() => { suppressClick.current = null }, 500)
                if (event.type === 'pointerup') void saveOrder(active.order)
                else setOrder(null)
            }
        }
        document.addEventListener('pointermove', move, { passive: false })
        document.addEventListener('pointerup', finish)
        document.addEventListener('pointercancel', finish)
        return () => {
            document.removeEventListener('pointermove', move)
            document.removeEventListener('pointerup', finish)
            document.removeEventListener('pointercancel', finish)
            if (suppressionTimer.current) clearTimeout(suppressionTimer.current)
        }
    }, [saveOrder])

    const start = (event: ReactPointerEvent<HTMLElement>, id: string, handle = false) => {
        if (!canReorder || savingRef.current || event.button !== 0) return
        // Touch users scroll the strip with the thumbnail surface. Reordering
        // remains available through the always-visible drag handle.
        if (event.pointerType === 'touch' && !handle) return
        suppressClick.current = null
        event.stopPropagation()
        if (handle) event.preventDefault()
        event.currentTarget.setPointerCapture?.(event.pointerId)
        drag.current = { id, pointerId: event.pointerId, x: event.clientX, y: event.clientY, started: false, order: props.attachments.map((a) => a.id) }
    }

    const keyDown = (event: KeyboardEvent<HTMLButtonElement>, id: string) => {
        if (!canReorder || savingRef.current) return
        const ids = attachments.map((a) => a.id)
        const index = ids.indexOf(id)
        const target = event.key === 'Home' ? 0 : event.key === 'End' ? ids.length - 1
            : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? index - 1
                : ['ArrowRight', 'ArrowDown'].includes(event.key) ? index + 1 : index
        if (target < 0 || target >= ids.length || target === index) return
        event.preventDefault()
        event.stopPropagation()
        const next = moveAttachmentId(ids, id, ids[target]!, target > index ? 'after' : 'before')
        setOrder(next)
        void saveOrder(next)
    }

    const scrollHorizontally = (event: ReactWheelEvent<HTMLDivElement>) => {
        if (event.deltaX === 0 && !event.shiftKey) return
        const element = event.currentTarget
        if (element.scrollWidth <= element.clientWidth) return
        event.preventDefault()
        element.scrollLeft += event.deltaX !== 0 ? event.deltaX : event.deltaY
    }

    return <div>
        <div
            ref={container}
            className="mt-0.5 mb-1 flex min-w-0 max-w-full items-start gap-2 overflow-x-auto overscroll-x-contain pb-1 pr-1 [scrollbar-width:thin]"
            data-testid="scratchlist-attachments"
            onWheel={scrollHorizontally}
            style={{ touchAction: 'pan-x pan-y' }}
        >
            {attachments.map((attachment) => {
                const src = isImageMimeType(attachment.mimeType) ? getScratchlistAttachmentPreview(attachment) : undefined
                const isImage = Boolean(src)
                return <div key={attachment.id}
                    data-testid={isImage ? 'scratchlist-attachment-thumb' : 'scratchlist-attachment-file'}
                    data-scratchlist-attachment-id={attachment.id}
                    data-scratchlist-action="attachment"
                    data-scratchlist-attachment-dragging={draggingId === attachment.id || undefined}
                    className={`${isImage ? 'group relative h-16 w-24 shrink-0 overflow-hidden rounded-lg bg-[var(--app-subtle-bg)]' : `relative flex min-w-0 max-w-[min(18rem,70vw)] shrink-0 items-center gap-1.5 rounded-lg bg-[var(--app-subtle-bg)] py-2 pr-2 text-base text-[var(--app-fg)] ${canReorder ? 'pl-2' : 'pl-3'}`} ${draggingId === attachment.id ? 'opacity-60' : ''}`}
                    onPointerDown={(event) => { if (!(event.target as Element).closest('button')) start(event, attachment.id) }}
                    onContextMenu={(event) => { if (drag.current?.id === attachment.id || suppressClick.current === attachment.id) { event.preventDefault(); event.stopPropagation() } }}>
                    {src ? <ImagePreview src={src} fileName={attachment.filename} label={attachment.filename} fileSize={attachment.size}
                        galleryId={`scratchlist-attachments-${props.sessionId}`}
                        buttonClassName={`group h-full w-full cursor-zoom-in overflow-hidden rounded-lg text-left ${canReorder ? 'touch-none' : ''}`}
                        imageClassName="h-full w-full object-cover"
                        onTriggerPointerDown={(event) => start(event, attachment.id)}
                        onTriggerClick={(event) => { if (suppressClick.current === attachment.id) { event.preventDefault(); suppressClick.current = null } }}
                        caption={<div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-1.5 pb-1 pt-3"><span className="block truncate text-[10px] leading-tight text-white">{attachment.filename}</span></div>}
                    /> : <span className="min-w-0 max-w-[150px] truncate" title={attachment.filename}>{attachment.filename}</span>}
                    {canReorder ? <button type="button" disabled={saving} data-testid="scratchlist-attachment-drag-handle" data-scratchlist-action="reorder-attachment"
                        aria-label={`Reorder attachment ${attachment.filename}`} title="Drag to reorder attachment"
                        onPointerDown={(event) => start(event, attachment.id, true)} onKeyDown={(event) => keyDown(event, attachment.id)}
                        className={isImage
                            ? 'hapi-scratchlist-attachment-control absolute left-1 top-1 z-20 flex h-8 w-8 touch-none cursor-grab items-start justify-start rounded-md bg-transparent text-white/90 transition-colors hover:bg-black/15 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--app-link)] active:cursor-grabbing'
                            : 'hapi-scratchlist-attachment-control hapi-scratchlist-attachment-file-control order-first -mx-1 flex h-6 w-6 shrink-0 touch-none cursor-grab items-center justify-center rounded-md text-[var(--app-hint)] hover:text-[var(--app-fg)] focus-visible:outline-2 active:cursor-grabbing'}>
                        {isImage ? <span className="flex h-5 w-5 items-center justify-center rounded bg-black/40 shadow-sm ring-1 ring-white/20"><DragIcon /></span> : <DragIcon />}
                    </button> : null}
                    <button type="button" data-scratchlist-action="remove-attachment" aria-label={`Remove attachment ${attachment.filename}`} title={`Remove attachment ${attachment.filename}`} disabled={props.disabled || saving}
                        onClick={(event) => { event.preventDefault(); event.stopPropagation(); props.onRemove(attachment.id) }}
                        className={isImage
                            ? 'hapi-scratchlist-attachment-control absolute right-1 top-1 z-20 flex h-8 w-8 items-start justify-end rounded-md bg-transparent text-white transition-colors hover:bg-black/15 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-white'
                            : 'hapi-scratchlist-attachment-control hapi-scratchlist-attachment-file-control -mx-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--app-hint)] hover:text-[var(--app-fg)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--app-link)]'}>
                        {isImage ? <span className="flex h-5 w-5 items-center justify-center rounded-md bg-black/40 shadow-sm ring-1 ring-white/20"><RemoveIcon /></span> : <RemoveIcon />}
                    </button>
                </div>
            })}
            {props.onAdd ? (
                <button
                    type="button"
                    data-testid="scratchlist-insert-attachment-plus"
                    data-scratchlist-action="insert-attachments"
                    aria-label={props.addLabel}
                    title={props.addLabel}
                    disabled={props.disabled || saving}
                    onClick={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        props.onAdd?.()
                    }}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-dashed border-[var(--app-border)] bg-[var(--app-subtle-bg)] text-[var(--app-hint)] transition-colors hover:border-[var(--app-hint)] hover:text-[var(--app-fg)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--app-link)] disabled:cursor-not-allowed disabled:opacity-40"
                >
                    <PlusIcon className="h-4 w-4" />
                </button>
            ) : null}
        </div>
        {error ? <p role="alert" className="text-xs text-red-500">{error}</p> : null}
    </div>
}
