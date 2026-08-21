import {
    type FormEvent as ReactFormEvent,
    type KeyboardEvent as ReactKeyboardEvent,
    type MouseEvent as ReactMouseEvent,
    type PointerEvent as ReactPointerEvent,
    type RefObject,
    type TouchEvent as ReactTouchEvent,
    useCallback,
    useEffect,
    useId,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from 'react'
import {
    addScratchlistEntry,
    deleteScratchlistEntry,
    persistScratchlist,
    readScratchlist,
    reorderScratchlistEntry,
    SCRATCHLIST_MAX_ENTRIES,
    SCRATCHLIST_MAX_TEXT_LENGTH,
    updateScratchlistEntry,
    type ScratchlistEntry,
} from '@/lib/scratchlist'
import { createPortal } from 'react-dom'
import type { ApiClient } from '@/api/client'
import type { ScratchlistAttachmentMetadata } from '@hapi/protocol'
import { isImageMimeType } from '@/lib/fileAttachments'
import { safeCopyToClipboard } from '@/lib/clipboard'
import { useTranslation } from '@/lib/use-translation'
import { HoverTooltip } from '@/components/HoverTooltip'
import { ImagePreview } from '@/components/ImagePreview'
import { CheckIcon } from '@/components/icons'
import { ScheduleTimePicker, type PendingSchedule } from './ScheduleTimePicker'
import {
    getScratchlistAttachmentPreview,
    releaseScratchlistAttachmentPreview,
    rememberScratchlistAttachmentObjectUrl,
    rememberScratchlistAttachmentPreview,
} from '@/lib/scratchlistAttachmentPreview'

const STORAGE_KEY_PREFIX = 'hapi.scratchlist-collapsed.v1.'

function readCollapsedPref(sessionId: string): boolean {
    if (typeof window === 'undefined') return true
    try {
        const raw = window.localStorage.getItem(`${STORAGE_KEY_PREFIX}${sessionId}`)
        return raw === null ? true : raw === '1'
    } catch {
        return true
    }
}

function writeCollapsedPref(sessionId: string, collapsed: boolean): void {
    if (typeof window === 'undefined') return
    try {
        window.localStorage.setItem(
            `${STORAGE_KEY_PREFIX}${sessionId}`,
            collapsed ? '1' : '0'
        )
    } catch {
        // Non-fatal.
    }
}

function NoteIcon() {
    return (
        <svg
            className="relative top-[0.03125rem] max-sm:-top-[0.0625rem] h-[0.8125rem] w-[0.8125rem] shrink-0 text-[var(--app-hint)]"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
            data-testid="scratchlist-note-icon"
        >
            <path
                d="M3.5 1.5h6L12.5 4.5v9a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1Z"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinejoin="round"
            />
            <path
                d="M9.5 1.5v3h3M5 8.5h6M5 11h4"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
            />
        </svg>
    )
}

function ChevronIcon({ open }: { open: boolean }) {
    return (
        <svg
            className={`h-3 w-3 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
            viewBox="0 0 12 12"
            fill="none"
            aria-hidden="true"
        >
            <path d="m4 3 4 3-4 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    )
}

function MoreIcon() {
    return (
        <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5" aria-hidden="true">
            <circle cx="3.5" cy="8" r="1" fill="currentColor" />
            <circle cx="8" cy="8" r="1" fill="currentColor" />
            <circle cx="12.5" cy="8" r="1" fill="currentColor" />
        </svg>
    )
}

function ScratchlistQuestionIcon() {
    return (
        <svg
            className="relative top-[0.03125rem] max-sm:-top-[0.0625rem] h-[0.8125rem] w-[0.8125rem] shrink-0"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
            data-testid="scratchlist-question-icon"
        >
            <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.4" />
            <path
                d="M6.25 6.25a1.75 1.75 0 1 1 2.9 1.33c-.72.55-1.15.87-1.15 1.67"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
            <circle cx="8" cy="12.1" r="0.9" fill="currentColor" />
        </svg>
    )
}

function ScratchlistRemoveIcon() {
    return (
        <svg
            viewBox="0 0 12 12"
            fill="none"
            className="h-3 w-3"
            aria-hidden="true"
        >
            <path
                d="m3 3 6 6M9 3 3 9"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
            />
        </svg>
    )
}

function ScratchlistHelpHint() {
    const { t } = useTranslation()
    const tooltipId = useId()
    const [clickOpen, setClickOpen] = useState(false)
    const containerRef = useRef<HTMLSpanElement>(null)

    useEffect(() => {
        if (!clickOpen) return

        const closeOnOutsidePointer = (event: PointerEvent) => {
            if (!containerRef.current?.contains(event.target as Node)) {
                setClickOpen(false)
            }
        }
        document.addEventListener('pointerdown', closeOnOutsidePointer)
        return () => document.removeEventListener('pointerdown', closeOnOutsidePointer)
    }, [clickOpen])

    const target = (
        <button
            type="button"
            className="inline-flex h-3.5 w-3.5 items-center justify-center text-[var(--app-hint)]"
            aria-label={t('scratchlist.drawerHintAriaLabel')}
            aria-expanded={clickOpen}
            aria-controls={tooltipId}
            onClick={(event) => {
                event.stopPropagation()
                if (clickOpen) {
                    event.currentTarget.blur()
                }
                setClickOpen((open) => !open)
            }}
            onKeyDown={(event) => {
                if (event.key === 'Escape') {
                    setClickOpen(false)
                }
            }}
        >
            <ScratchlistQuestionIcon />
        </button>
    )

    return (
        <HoverTooltip
            id={tooltipId}
            target={target}
            side="bottom"
            align="end"
            open={clickOpen}
            containerRef={containerRef}
            hoverGroup="help"
            tooltipClassName="pointer-events-auto w-56"
        >
            {t('scratchlist.drawerHint')}
        </HoverTooltip>
    )
}

/**
 * Inventory list with per-entry action buttons. Pure presentational - takes
 * entries + callbacks. Used by both the always-visible ScratchlistPanel
 * and the composer-controlled drawer below.
 */
function ScratchlistAttachmentThumbnails(props: {
    sessionId: string
    api: ApiClient
    attachments: Array<ScratchlistAttachmentMetadata & { previewUrl?: string }>
    onRemove: (attachmentId: string) => void
}) {
    type Thumbnail = { id: string; url: string; filename: string }
    const imageAttachments = useMemo(
        () => props.attachments.filter((attachment) => isImageMimeType(attachment.mimeType)),
        [props.attachments],
    )
    const imageAttachmentKey = useMemo(
        () => imageAttachments
            .map((attachment) => [
                attachment.id,
                attachment.filename,
                attachment.mimeType,
                attachment.size,
                attachment.path,
                attachment.previewUrl ?? '',
            ].join('\u001f'))
            .join('\u001e'),
        [imageAttachments],
    )
    const resolveCachedThumbnails = useCallback((
        attachments: Array<ScratchlistAttachmentMetadata & { previewUrl?: string }>,
    ): Thumbnail[] => attachments.flatMap((attachment) => {
        const url = getScratchlistAttachmentPreview(attachment)
        return url ? [{ id: attachment.id, url, filename: attachment.filename }] : []
    }), [])
    const initialUrls = useMemo(
        () => resolveCachedThumbnails(imageAttachments),
        [imageAttachments, resolveCachedThumbnails],
    )
    const [urls, setUrls] = useState<Thumbnail[]>(initialUrls)
    const imageAttachmentsRef = useRef(imageAttachments)
    imageAttachmentsRef.current = imageAttachments

    useEffect(() => {
        let cancelled = false
        const attachments = imageAttachmentsRef.current
        for (const attachment of attachments) {
            rememberScratchlistAttachmentPreview(attachment, attachment.previewUrl)
        }
        setUrls(resolveCachedThumbnails(attachments))
        void (async () => {
            const missing = attachments.filter((attachment) => !getScratchlistAttachmentPreview(attachment))
            await Promise.all(missing.map(async (attachment) => {
                try {
                    const blob = await props.api.fetchScratchlistAttachmentBlob(props.sessionId, attachment.id)
                    const objectUrl = URL.createObjectURL(blob)
                    rememberScratchlistAttachmentObjectUrl(attachment, objectUrl)
                } catch {
                    // Non-fatal: entry still shows text/actions.
                }
            }))
            if (!cancelled) {
                setUrls(resolveCachedThumbnails(attachments))
            }
        })()
        return () => {
            cancelled = true
        }
    }, [imageAttachmentKey, props.api, props.sessionId, resolveCachedThumbnails])

    if (urls.length === 0) return null

    return (
        <div
            className="mt-0.5 mb-1 flex flex-wrap gap-1.5"
            data-testid="scratchlist-attachment-thumbs"
        >
            {urls.map((item) => (
                <div
                    key={item.id}
                    className="group relative h-16 w-24 overflow-hidden rounded-lg bg-[var(--app-subtle-bg)]"
                    data-testid="scratchlist-attachment-thumb"
                >
                    <ImagePreview
                        src={item.url}
                        fileName={item.filename}
                        label={item.filename}
                        galleryId={`scratchlist-attachments-${props.sessionId}`}
                        buttonClassName="group h-full w-full cursor-zoom-in overflow-hidden rounded-lg text-left"
                        imageClassName="h-full w-full object-cover transition-opacity group-hover:opacity-85"
                        caption={(
                            <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-1.5 pb-1 pt-3">
                                <span className="block truncate text-[10px] leading-tight text-white">{item.filename}</span>
                            </div>
                        )}
                    />
                    <button
                        type="button"
                        data-scratchlist-action="remove-attachment"
                        aria-label={`Remove attachment ${item.filename}`}
                        title={`Remove attachment ${item.filename}`}
                        onClick={(event) => {
                            event.preventDefault()
                            event.stopPropagation()
                            releaseScratchlistAttachmentPreview(item.id)
                            props.onRemove(item.id)
                        }}
                        className="absolute right-1 top-1 z-10 flex h-6 w-6 items-center justify-center rounded-full bg-black/65 text-white transition-colors hover:bg-black/85 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-white"
                    >
                        <ScratchlistRemoveIcon />
                    </button>
                </div>
            ))}
        </div>
    )
}

function ScratchlistFileAttachments(props: {
    attachments: Array<ScratchlistAttachmentMetadata & { previewUrl?: string }>
    onRemove: (attachmentId: string) => void
}) {
    const fileAttachments = props.attachments.filter((attachment) => !isImageMimeType(attachment.mimeType))
    if (fileAttachments.length === 0) return null

    return (
        <div
            className="mt-0.5 mb-1 flex min-w-0 flex-col gap-1"
            data-testid="scratchlist-attachment-files"
        >
            {fileAttachments.map((attachment) => (
                <div
                    key={attachment.id}
                    className="flex min-w-0 items-center gap-1.5 rounded-md bg-[var(--app-subtle-bg)] px-2 py-1"
                    data-testid="scratchlist-attachment-file"
                >
                    <span
                        className="min-w-0 flex-1 truncate text-xs text-[var(--app-hint)]"
                        title={attachment.filename}
                    >
                        {attachment.filename}
                    </span>
                    <button
                        type="button"
                        data-scratchlist-action="remove-attachment"
                        aria-label={`Remove attachment ${attachment.filename}`}
                        title={`Remove attachment ${attachment.filename}`}
                        onClick={(event) => {
                            event.preventDefault()
                            event.stopPropagation()
                            props.onRemove(attachment.id)
                        }}
                        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--app-link)]"
                    >
                        <ScratchlistRemoveIcon />
                    </button>
                </div>
            ))}
        </div>
    )
}

const LONG_PRESS_TO_DRAG_MS = 450
const DRAG_CANCEL_DISTANCE_PX = 8
const COPY_SUCCESS_FEEDBACK_MS = 1000

type PointerDragState = {
    entryId: string
    pointerId: number
    startX: number
    startY: number
    row: HTMLLIElement
    timer: number
    active: boolean
}

type TouchDragState = {
    entryId: string
    touchId: number
    startX: number
    startY: number
    currentX: number
    currentY: number
    row: HTMLLIElement
    timer: number
    active: boolean
}

function isScratchlistActionTarget(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return true
    if (target.closest('[data-scratchlist-action]')) return true
    return Boolean(target.closest('textarea, input, select, a'))
}

function getScratchlistDropTarget(
    clientX: number,
    clientY: number,
    fallbackTarget: EventTarget | null,
): string | null {
    const pointTarget = typeof document.elementFromPoint === 'function'
        ? document.elementFromPoint(clientX, clientY)
        : null
    const target = pointTarget ?? fallbackTarget
    if (!(target instanceof Element)) return null
    return target.closest<HTMLElement>('[data-testid="scratchlist-entry"]')?.dataset.entryId ?? null
}

type TouchPoint = {
    identifier: number
    clientX: number
    clientY: number
}

type TouchCollection = {
    length: number
    [index: number]: TouchPoint | undefined
}

function findTouch(touches: TouchCollection | undefined, touchId: number): TouchPoint | null {
    if (!touches) return null
    for (let index = 0; index < touches.length; index += 1) {
        const touch = touches[index]
        if (touch?.identifier === touchId) return touch
    }
    return null
}

type ScratchlistEntryAction = (entry: ScratchlistEntry) => void | Promise<boolean | void>
type ScratchlistScheduleAction = (
    entry: ScratchlistEntry,
    pending: PendingSchedule,
) => void | Promise<boolean | void>

type ScratchlistMenuState = {
    entryId: string
    left: number
    top: number
}

function clampScratchlistMenuPosition(left: number, top: number): { left: number; top: number } {
    if (typeof window === 'undefined') return { left, top }
    const menuWidth = 224
    const menuHeight = 220
    return {
        left: Math.min(Math.max(8, left), Math.max(8, window.innerWidth - menuWidth - 8)),
        top: Math.min(Math.max(8, top), Math.max(8, window.innerHeight - menuHeight - 8)),
    }
}

function ScratchlistActionMenu({
    entry,
    position,
    menuRef,
    scheduleAnchorRef,
    scheduleOpen,
    onClose,
    onCopy,
    onDelete,
    onSend,
    onOpenSchedule,
    onSchedule,
    disabled,
    actionPending,
}: {
    entry: ScratchlistEntry
    position: ScratchlistMenuState
    menuRef: RefObject<HTMLDivElement | null>
    scheduleAnchorRef: RefObject<HTMLButtonElement | null>
    scheduleOpen: boolean
    onClose: () => void
    onCopy: () => void
    onDelete: () => void
    onSend?: () => void
    onOpenSchedule: () => void
    onSchedule?: (pending: PendingSchedule) => void
    disabled: boolean
    actionPending: boolean
}) {
    const { t } = useTranslation()
    const menu = (
        <div
            ref={menuRef}
            role="menu"
            aria-label={t('scratchlist.action.menuAriaLabel')}
            data-testid="scratchlist-action-menu"
            className="z-[60] min-w-56 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-1 text-sm text-[var(--app-fg)] shadow-xl"
            style={{ position: 'fixed', left: position.left, top: position.top }}
            onPointerDown={(event) => event.stopPropagation()}
        >
            <button
                type="button"
                role="menuitem"
                data-scratchlist-action="copy"
                aria-label={t('scratchlist.action.copy')}
                className="flex w-full items-center rounded-md px-3 py-2 text-left hover:bg-[var(--app-subtle-bg)] disabled:cursor-not-allowed disabled:opacity-40"
                onClick={() => {
                    onCopy()
                    onClose()
                }}
                disabled={actionPending}
            >
                {t('scratchlist.action.copy')}
            </button>
            {onSend ? (
                <button
                    type="button"
                    role="menuitem"
                    data-scratchlist-action="send-now"
                    className="flex w-full items-center rounded-md px-3 py-2 text-left hover:bg-[var(--app-subtle-bg)] disabled:cursor-not-allowed disabled:opacity-40"
                    onClick={onSend}
                    disabled={disabled || actionPending}
                >
                    {t('scratchlist.action.sendNow')}
                </button>
            ) : null}
            {onSend && onSchedule ? (
                <button
                    ref={scheduleAnchorRef}
                    type="button"
                    role="menuitem"
                    data-scratchlist-action="schedule"
                    aria-expanded={scheduleOpen}
                    className="flex w-full items-center rounded-md px-3 py-2 text-left hover:bg-[var(--app-subtle-bg)] disabled:cursor-not-allowed disabled:opacity-40"
                    onClick={onOpenSchedule}
                    disabled={disabled || actionPending}
                >
                    {t('scratchlist.action.scheduleSend')}
                </button>
            ) : null}
            <div className="my-1 border-t border-[var(--app-border)]" role="separator" />
            <button
                type="button"
                role="menuitem"
                data-scratchlist-action="delete"
                className="flex w-full items-center rounded-md px-3 py-2 text-left text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 disabled:cursor-not-allowed disabled:opacity-40"
                onClick={() => {
                    onDelete()
                    onClose()
                }}
                disabled={disabled || actionPending}
            >
                {t('scratchlist.action.delete')}
            </button>
            {scheduleOpen && onSchedule ? (
                <div data-scratchlist-schedule-picker="" onPointerDown={(event) => event.stopPropagation()}>
                    <ScheduleTimePicker
                        anchorRef={scheduleAnchorRef}
                        onSchedule={onSchedule}
                        onClose={onClose}
                    />
                </div>
            ) : null}
        </div>
    )

    return typeof document === 'undefined' ? null : createPortal(menu, document.body)
}

function ScratchlistInventory({
    entries,
    onUpdate,
    onReorder,
    onDelete,
    onSend,
    onSchedule,
    sessionId,
    api,
    disabled = false,
    listMarginClassName = 'mt-1',
    emptyMarginClassName = 'mt-2',
}: {
    entries: ScratchlistEntry[]
    onUpdate: (
        entry: ScratchlistEntry,
        text: string,
        attachments?: ScratchlistAttachmentMetadata[],
    ) => void | Promise<void>
    onReorder: (entryId: string, targetIndex: number) => void
    onDelete: (entry: ScratchlistEntry) => void
    onSend?: ScratchlistEntryAction
    onSchedule?: ScratchlistScheduleAction
    sessionId?: string
    api?: ApiClient
    disabled?: boolean
    listMarginClassName?: string
    emptyMarginClassName?: string
}) {
    const { t } = useTranslation()
    const [editingEntryId, setEditingEntryId] = useState<string | null>(null)
    const [editingText, setEditingText] = useState('')
    const [copySuccessEntryId, setCopySuccessEntryId] = useState<string | null>(null)
    const [draggingEntryId, setDraggingEntryId] = useState<string | null>(null)
    const [dragOverEntryId, setDragOverEntryId] = useState<string | null>(null)
    const [menuState, setMenuState] = useState<ScratchlistMenuState | null>(null)
    const [scheduleEntryId, setScheduleEntryId] = useState<string | null>(null)
    const [actionPendingEntryId, setActionPendingEntryId] = useState<string | null>(null)
    const pointerDragRef = useRef<PointerDragState | null>(null)
    const touchDragRef = useRef<TouchDragState | null>(null)
    const touchContextMenuRef = useRef(false)
    const editingTextareaRef = useRef<HTMLTextAreaElement | null>(null)
    const menuRef = useRef<HTMLDivElement | null>(null)
    const scheduleAnchorRef = useRef<HTMLButtonElement | null>(null)
    const copySuccessTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const suppressClickRef = useRef(false)
    const editCompletionRef = useRef(false)
    const scrollViewportRef = useRef<HTMLDivElement | null>(null)
    const entriesRef = useRef(entries)
    entriesRef.current = entries

    useLayoutEffect(() => {
        const viewport = scrollViewportRef.current
        if (!viewport) return

        const updateScrollbarGutter = () => {
            const scrollbarWidth = Math.max(0, viewport.offsetWidth - viewport.clientWidth)
            viewport.style.setProperty('--scratchlist-scrollbar-width', `${scrollbarWidth}px`)
        }

        updateScrollbarGutter()
        if (typeof ResizeObserver === 'undefined') return

        const observer = new ResizeObserver(updateScrollbarGutter)
        observer.observe(viewport)
        return () => observer.disconnect()
    }, [entries.length])

    const closeMenu = useCallback(() => {
        setMenuState(null)
        setScheduleEntryId(null)
    }, [])

    const openMenu = useCallback((entry: ScratchlistEntry, left: number, top: number) => {
        const position = clampScratchlistMenuPosition(left, top)
        setMenuState({ entryId: entry.id, ...position })
        setScheduleEntryId(null)
    }, [])

    useEffect(() => {
        if (!menuState) return

        const closeOnOutsidePointer = (event: globalThis.PointerEvent) => {
            const target = event.target
            if (target instanceof Node && menuRef.current?.contains(target)) return
            if (target instanceof Element && target.closest('[data-scratchlist-schedule-picker]')) return
            closeMenu()
        }
        const closeOnEscape = (event: globalThis.KeyboardEvent) => {
            if (event.key === 'Escape') closeMenu()
        }
        const closeOnViewportChange = () => closeMenu()
        document.addEventListener('pointerdown', closeOnOutsidePointer)
        document.addEventListener('keydown', closeOnEscape)
        window.addEventListener('resize', closeOnViewportChange)
        return () => {
            document.removeEventListener('pointerdown', closeOnOutsidePointer)
            document.removeEventListener('keydown', closeOnEscape)
            window.removeEventListener('resize', closeOnViewportChange)
        }
    }, [closeMenu, menuState])

    useEffect(() => {
        if (menuState && !entries.some((entry) => entry.id === menuState.entryId)) {
            closeMenu()
        }
    }, [closeMenu, entries, menuState])

    const runEntryAction = useCallback(async (
        entry: ScratchlistEntry,
        action: ScratchlistEntryAction | undefined,
    ) => {
        if (!action || disabled || actionPendingEntryId) return
        setActionPendingEntryId(entry.id)
        try {
            await action(entry)
        } finally {
            setActionPendingEntryId(null)
            closeMenu()
        }
    }, [actionPendingEntryId, closeMenu, disabled])

    const handleContextMenu = useCallback((entry: ScratchlistEntry, event: ReactMouseEvent<HTMLLIElement>) => {
        const sourceCapabilities = (event.nativeEvent as MouseEvent & {
            sourceCapabilities?: { firesTouchEvents?: boolean } | null
        }).sourceCapabilities
        if (sourceCapabilities?.firesTouchEvents || touchContextMenuRef.current || touchDragRef.current) {
            event.preventDefault()
            return
        }
        if (isScratchlistActionTarget(event.target)) {
            event.preventDefault()
            return
        }
        event.preventDefault()
        openMenu(entry, event.clientX, event.clientY)
    }, [openMenu])

    const handleCopy = useCallback(async (entry: ScratchlistEntry) => {
        try {
            await safeCopyToClipboard(entry.text)
            setCopySuccessEntryId(entry.id)
            if (copySuccessTimerRef.current) clearTimeout(copySuccessTimerRef.current)
            copySuccessTimerRef.current = setTimeout(() => {
                setCopySuccessEntryId((current) => current === entry.id ? null : current)
                copySuccessTimerRef.current = null
            }, COPY_SUCCESS_FEEDBACK_MS)
        } catch {
            // safeCopyToClipboard exhausted both the navigator.clipboard
            // path and the execCommand fallback; nothing useful left to do.
            // Silently no-op rather than throw at the click handler.
        }
    }, [])

    useEffect(() => () => {
        if (copySuccessTimerRef.current) clearTimeout(copySuccessTimerRef.current)
    }, [])

    const clearPointerDrag = useCallback((state: PointerDragState | null) => {
        if (!state) return
        window.clearTimeout(state.timer)
        if (typeof state.row.hasPointerCapture === 'function' && state.row.hasPointerCapture(state.pointerId)) {
            state.row.releasePointerCapture(state.pointerId)
        }
        if (pointerDragRef.current === state) pointerDragRef.current = null
        setDraggingEntryId(null)
        setDragOverEntryId(null)
    }, [])

    const finishPointerGesture = useCallback((event: ReactPointerEvent<HTMLLIElement>, commit: boolean) => {
        const state = pointerDragRef.current
        if (!state || state.pointerId !== event.pointerId) return

        if (commit && state.active) {
            const targetId = getScratchlistDropTarget(event.clientX, event.clientY, event.target)
            const targetIndex = targetId
                ? entriesRef.current.findIndex((entry) => entry.id === targetId)
                : -1
            if (targetIndex >= 0 && targetId !== state.entryId) {
                onReorder(state.entryId, targetIndex)
            }
            // A long press is a drag gesture, even when it ends over the
            // source row. Suppress the synthetic click that touch browsers
            // dispatch after the gesture so it cannot unexpectedly open the
            // inline editor.
            if (state.active) {
                suppressClickRef.current = true
                window.setTimeout(() => {
                    suppressClickRef.current = false
                }, 250)
            }
        }
        clearPointerDrag(state)
    }, [clearPointerDrag, onReorder])

    const clearTouchDrag = useCallback((state: TouchDragState | null) => {
        if (!state) return
        window.clearTimeout(state.timer)
        if (touchDragRef.current === state) touchDragRef.current = null
        setDraggingEntryId(null)
        setDragOverEntryId(null)
    }, [])

    const finishTouchGesture = useCallback((event: ReactTouchEvent<HTMLLIElement>, commit: boolean) => {
        const state = touchDragRef.current
        if (!state) return

        const touch = findTouch(event.changedTouches, state.touchId)
            ?? findTouch(event.touches, state.touchId)
        if (touch) {
            state.currentX = touch.clientX
            state.currentY = touch.clientY
        }

        if (commit && state.active) {
            const targetId = getScratchlistDropTarget(state.currentX, state.currentY, state.row)
            const targetIndex = targetId
                ? entriesRef.current.findIndex((entry) => entry.id === targetId)
                : -1
            if (targetIndex >= 0 && targetId !== state.entryId) {
                onReorder(state.entryId, targetIndex)
            }
            suppressClickRef.current = true
            window.setTimeout(() => {
                suppressClickRef.current = false
            }, 250)
        }
        clearTouchDrag(state)
    }, [clearTouchDrag, onReorder])

    useEffect(() => () => {
        const state = pointerDragRef.current
        if (state) {
            window.clearTimeout(state.timer)
            if (typeof state.row.hasPointerCapture === 'function' && state.row.hasPointerCapture(state.pointerId)) {
                state.row.releasePointerCapture(state.pointerId)
            }
        }
        const touchState = touchDragRef.current
        if (touchState) {
            window.clearTimeout(touchState.timer)
        }
    }, [])

    // A mobile browser may start native scrolling after a long press even
    // though the row has entered drag mode. This non-passive listener lets the
    // active touch gesture take over without disabling normal list scrolling
    // before the long-press threshold is reached.
    useEffect(() => {
        const preventNativeTouchScroll = (event: globalThis.TouchEvent) => {
            const state = touchDragRef.current
            if (!state?.active) return
            if (findTouch(event.touches, state.touchId) || findTouch(event.changedTouches, state.touchId)) {
                event.preventDefault()
            }
        }
        document.addEventListener('touchmove', preventNativeTouchScroll, { passive: false })
        return () => document.removeEventListener('touchmove', preventNativeTouchScroll)
    }, [])

    useEffect(() => {
        if (editingEntryId && !entries.some((entry) => entry.id === editingEntryId)) {
            setEditingEntryId(null)
            setEditingText('')
        }
    }, [editingEntryId, entries])

    useLayoutEffect(() => {
        if (!editingEntryId) return
        const editor = editingTextareaRef.current
        if (!editor) return

        editor.focus()
        const end = editor.value.length
        editor.setSelectionRange(end, end)
    }, [editingEntryId])

    useLayoutEffect(() => {
        if (!editingEntryId) return
        const editor = editingTextareaRef.current
        if (!editor) return

        // Let the textarea follow its content instead of introducing a
        // second, independently scrolling viewport inside the row.
        editor.style.height = 'auto'
        editor.style.height = `${editor.scrollHeight}px`
    }, [editingEntryId, editingText])

    const handlePointerDown = useCallback((entry: ScratchlistEntry, event: ReactPointerEvent<HTMLLIElement>) => {
        if (disabled || editingEntryId || event.pointerType === 'touch' || event.button !== 0 || isScratchlistActionTarget(event.target)) return
        const previous = pointerDragRef.current
        if (previous) clearPointerDrag(previous)

        const row = event.currentTarget
        const state: PointerDragState = {
            entryId: entry.id,
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            row,
            timer: window.setTimeout(() => {
                if (pointerDragRef.current !== state) return
                if (typeof state.row.setPointerCapture === 'function') {
                    state.row.setPointerCapture(state.pointerId)
                }
                state.active = true
                setDraggingEntryId(state.entryId)
                setDragOverEntryId(null)
            }, LONG_PRESS_TO_DRAG_MS),
            active: false,
        }
        pointerDragRef.current = state
    }, [clearPointerDrag, disabled, editingEntryId])

    const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLLIElement>) => {
        const state = pointerDragRef.current
        if (!state || state.pointerId !== event.pointerId) return
        const moved = Math.hypot(event.clientX - state.startX, event.clientY - state.startY)
        if (!state.active) {
            if (moved > DRAG_CANCEL_DISTANCE_PX) finishPointerGesture(event, false)
            return
        }

        event.preventDefault()
        const targetId = getScratchlistDropTarget(event.clientX, event.clientY, event.target)
        setDragOverEntryId(targetId && targetId !== state.entryId ? targetId : null)
    }, [finishPointerGesture])

    const handleTouchStart = useCallback((entry: ScratchlistEntry, event: ReactTouchEvent<HTMLLIElement>) => {
        touchContextMenuRef.current = true
        window.setTimeout(() => {
            touchContextMenuRef.current = false
        }, 1000)
        if (disabled || editingEntryId || isScratchlistActionTarget(event.target)) return
        const touch = event.changedTouches[0] ?? event.touches[0]
        if (!touch) return

        const previous = touchDragRef.current
        if (previous) clearTouchDrag(previous)

        const row = event.currentTarget
        const state: TouchDragState = {
            entryId: entry.id,
            touchId: touch.identifier,
            startX: touch.clientX,
            startY: touch.clientY,
            currentX: touch.clientX,
            currentY: touch.clientY,
            row,
            timer: window.setTimeout(() => {
                if (touchDragRef.current !== state) return
                state.active = true
                setDraggingEntryId(state.entryId)
                setDragOverEntryId(null)
            }, LONG_PRESS_TO_DRAG_MS),
            active: false,
        }
        touchDragRef.current = state
    }, [clearTouchDrag, disabled, editingEntryId])

    const handleTouchMove = useCallback((event: ReactTouchEvent<HTMLLIElement>) => {
        const state = touchDragRef.current
        if (!state) return
        const touch = findTouch(event.touches, state.touchId)
            ?? findTouch(event.changedTouches, state.touchId)
        if (!touch) return

        state.currentX = touch.clientX
        state.currentY = touch.clientY
        const moved = Math.hypot(state.currentX - state.startX, state.currentY - state.startY)
        if (!state.active) {
            if (moved > DRAG_CANCEL_DISTANCE_PX) clearTouchDrag(state)
            return
        }

        event.preventDefault()
        const targetId = getScratchlistDropTarget(state.currentX, state.currentY, event.target)
        setDragOverEntryId(targetId && targetId !== state.entryId ? targetId : null)
    }, [clearTouchDrag])

    const startEditing = useCallback((entry: ScratchlistEntry) => {
        if (disabled) return
        if (suppressClickRef.current) {
            suppressClickRef.current = false
            return
        }
        editCompletionRef.current = false
        setEditingEntryId(entry.id)
        setEditingText(entry.text)
    }, [disabled])

    const removeAttachment = useCallback((entry: ScratchlistEntry, attachmentId: string) => {
        if (disabled) return
        const attachments = entry.attachments ?? []
        const nextAttachments = attachments.filter((attachment) => attachment.id !== attachmentId)
        if (nextAttachments.length === attachments.length) return
        releaseScratchlistAttachmentPreview(attachmentId)
        if (entry.text.trim().length === 0 && nextAttachments.length === 0) {
            onDelete(entry)
            return
        }
        void onUpdate(entry, entry.text, nextAttachments)
    }, [disabled, onDelete, onUpdate])

    const handleSend = useCallback((entry: ScratchlistEntry) => {
        void runEntryAction(entry, onSend)
    }, [onSend, runEntryAction])

    const handleSchedule = useCallback((entry: ScratchlistEntry, pending: PendingSchedule) => {
        if (!onSchedule) return
        void runEntryAction(entry, (current) => onSchedule(current, pending))
    }, [onSchedule, runEntryAction])

    const finishEditing = useCallback((entry: ScratchlistEntry) => {
        if (editCompletionRef.current) {
            editCompletionRef.current = false
            return
        }
        editCompletionRef.current = true
        const nextText = editingText.trim()
        setEditingEntryId(null)
        setEditingText('')
        const hasAttachments = (entry.attachments?.length ?? 0) > 0
        if (nextText !== entry.text && (nextText.length > 0 || hasAttachments)) {
            void onUpdate(entry, nextText)
        }
    }, [editingText, onUpdate])

    const cancelEditing = useCallback(() => {
        editCompletionRef.current = true
        setEditingEntryId(null)
        setEditingText('')
        window.setTimeout(() => {
            editCompletionRef.current = false
        }, 0)
    }, [])

    if (entries.length === 0) {
        return (
            <p className={`${emptyMarginClassName} text-[11px] text-[var(--app-hint)]`}>
                {t('scratchlist.emptyHint')}
            </p>
        )
    }

    return (
        <div
            ref={scrollViewportRef}
            className={`${listMarginClassName} scratchlist-scroll-y max-h-64`}
            data-testid="scratchlist-scroll-viewport"
        >
            <ul
                aria-label={t('scratchlist.listAriaLabel')}
                className="scratchlist-scroll-content flex min-h-0 flex-col gap-1.5"
            >
                {entries.map((entry) => {
                const isEditing = editingEntryId === entry.id
                const isDragging = draggingEntryId === entry.id
                const isDragOver = dragOverEntryId === entry.id
                return (
                    <li
                        key={entry.id}
                        data-entry-id={entry.id}
                        data-testid="scratchlist-entry"
                        data-dragging={isDragging ? '' : undefined}
                        data-drag-over={isDragOver ? '' : undefined}
                        title={t('scratchlist.action.dragToReorder')}
                        onPointerDown={(event) => handlePointerDown(entry, event)}
                        onPointerMove={handlePointerMove}
                        onPointerUp={(event) => finishPointerGesture(event, true)}
                        onPointerCancel={(event) => finishPointerGesture(event, false)}
                        onTouchStart={(event) => handleTouchStart(entry, event)}
                        onTouchMove={handleTouchMove}
                        onTouchEnd={(event) => finishTouchGesture(event, true)}
                        onTouchCancel={(event) => finishTouchGesture(event, false)}
                        onContextMenu={(event) => handleContextMenu(entry, event)}
                        className={`group relative flex shrink-0 min-h-9 select-none flex-col gap-1 rounded-md bg-[var(--app-bg)] px-2 py-1.5 transition-[background-color,opacity,box-shadow] hover:bg-[var(--app-subtle-bg)] focus-within:bg-[var(--app-subtle-bg)] ${
                            isDragging ? 'touch-none cursor-grabbing bg-[var(--app-subtle-bg)] opacity-90 ring-2 ring-inset ring-[var(--app-badge-warning-border)]' : 'touch-pan-y'
                        } ${isDragOver ? 'ring-2 ring-inset ring-[var(--app-badge-warning-border)]' : ''}`}
                        style={{ touchAction: isDragging ? 'none' : 'pan-y' }}
                    >
                        <div className="flex min-h-6 items-center gap-2">
                            <div
                                className="min-w-0 flex-1"
                                data-testid="scratchlist-entry-content"
                            >
                                {sessionId && api && entry.attachments && entry.attachments.length > 0 ? (
                                    <ScratchlistAttachmentThumbnails
                                        sessionId={sessionId}
                                        api={api}
                                        attachments={entry.attachments}
                                        onRemove={(attachmentId) => removeAttachment(entry, attachmentId)}
                                    />
                                ) : null}
                                {entry.attachments && entry.attachments.length > 0 ? (
                                    <ScratchlistFileAttachments
                                        attachments={entry.attachments}
                                        onRemove={(attachmentId) => removeAttachment(entry, attachmentId)}
                                    />
                                ) : null}
                                {isEditing ? (
                                    <textarea
                                        ref={editingTextareaRef}
                                        rows={1}
                                        value={editingText}
                                        maxLength={SCRATCHLIST_MAX_TEXT_LENGTH}
                                        aria-label={t('scratchlist.action.editEntry')}
                                        onChange={(event) => setEditingText(event.target.value)}
                                        onBlur={() => finishEditing(entry)}
                                        onKeyDown={(event) => {
                                            if (event.key === 'Escape') {
                                                event.preventDefault()
                                                cancelEditing()
                                            } else if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                                                event.preventDefault()
                                                finishEditing(entry)
                                            }
                                        }}
                                        className="block min-h-6 w-full resize-none overflow-hidden bg-transparent p-0 text-sm leading-6 text-[var(--app-fg)] focus:outline-none focus:ring-0"
                                    />
                                ) : (
                                    <button
                                        type="button"
                                        data-testid="scratchlist-entry-text"
                                        data-scratchlist-text=""
                                        title={t('scratchlist.action.editEntry')}
                                        onClick={() => startEditing(entry)}
                                        disabled={disabled}
                                        className="min-h-6 min-w-0 w-full cursor-text rounded text-left text-sm leading-6 text-[var(--app-fg)] outline-none line-clamp-4 whitespace-pre-wrap break-words focus-visible:ring-1 focus-visible:ring-[var(--app-link)] disabled:cursor-not-allowed disabled:opacity-60"
                                    >
                                        {entry.text}
                                    </button>
                                )}
                            </div>
                            <button
                                type="button"
                                data-scratchlist-action="menu"
                                data-scratchlist-copy-success={copySuccessEntryId === entry.id ? '' : undefined}
                                aria-haspopup="menu"
                                aria-expanded={menuState?.entryId === entry.id}
                                aria-label={t('scratchlist.action.more')}
                                title={t('scratchlist.action.more')}
                                onClick={(event) => {
                                    event.preventDefault()
                                    event.stopPropagation()
                                    const rect = event.currentTarget.getBoundingClientRect()
                                    openMenu(entry, rect.right - 224, rect.bottom + 4)
                                }}
                                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 sm:focus-visible:opacity-100 ${copySuccessEntryId === entry.id ? 'text-[var(--app-badge-success-text)]' : ''}`}
                            >
                                {copySuccessEntryId === entry.id
                                    ? <CheckIcon className="h-3.5 w-3.5" />
                                    : <MoreIcon />}
                            </button>
                        </div>
                        {menuState?.entryId === entry.id ? (
                            <ScratchlistActionMenu
                                entry={entry}
                                position={menuState}
                                menuRef={menuRef}
                                scheduleAnchorRef={scheduleAnchorRef}
                                scheduleOpen={scheduleEntryId === entry.id}
                                onClose={closeMenu}
                                onCopy={() => { void handleCopy(entry) }}
                                onDelete={() => onDelete(entry)}
                                onSend={onSend ? () => handleSend(entry) : undefined}
                                onOpenSchedule={() => setScheduleEntryId(entry.id)}
                                onSchedule={(pending) => handleSchedule(entry, pending)}
                                disabled={disabled}
                                actionPending={actionPendingEntryId === entry.id}
                            />
                        ) : null}
                    </li>
                    )
                })}
            </ul>
        </div>
    )
}

/**
 * Composer-controlled drawer. No own header / no own textarea: the composer
 * is the input source (composerSendsToScratchlist toggle in SessionChat).
 *
 * State is owned by the caller via useScratchlist(). The drawer is purely
 * presentational + behavior glue around the inventory list.
 */
export function ScratchlistDrawer({
    entries,
    onUpdate,
    onReorder,
    onDelete,
    onSend,
    onSchedule,
    sessionId,
    api,
    disabled = false,
}: {
    entries: ScratchlistEntry[]
    onUpdate: (
        id: string,
        text: string,
        attachments?: ScratchlistAttachmentMetadata[],
    ) => void | Promise<void>
    onReorder: (id: string, targetIndex: number) => void
    onDelete: (id: string) => void
    onSend?: ScratchlistEntryAction
    onSchedule?: ScratchlistScheduleAction
    sessionId: string
    api: ApiClient
    disabled?: boolean
}) {
    const { t } = useTranslation()
    const summary = useMemo(() => {
        if (entries.length === 0) return null
        if (entries.length === 1) return t('scratchlist.count.one')
        return t('scratchlist.count.other', { n: entries.length })
    }, [entries.length, t])

    const handleDelete = useCallback((entry: ScratchlistEntry) => {
        if (disabled) return
        for (const attachment of entry.attachments ?? []) {
            releaseScratchlistAttachmentPreview(attachment.id)
        }
        onDelete(entry.id)
    }, [disabled, onDelete])

    return (
        <div className="mx-auto w-full max-w-content mb-1">
            <div
                className="rounded-lg border border-[var(--app-badge-warning-border)] bg-[var(--app-chat-user-surface-bg)]"
                data-testid="scratchlist-drawer"
            >
                <div className="px-3 pb-3 pt-2">
                    <div className="flex h-4 items-center gap-0 text-xs font-medium leading-4 text-[var(--app-fg)]">
                        <div className="flex min-w-0 flex-1 items-center">
                            <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                                <NoteIcon />
                            </span>
                            <span className="flex h-4 min-w-0 flex-1 items-center truncate">
                                {t('scratchlist.title')}
                            </span>
                        </div>
                        {summary ? (
                            <span
                                className="mr-[0.09375rem] shrink-0 whitespace-nowrap"
                                data-testid="scratchlist-count"
                            >
                                {summary}
                            </span>
                        ) : null}
                        <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                            <ScratchlistHelpHint />
                        </span>
                    </div>
                    <ScratchlistInventory
                        entries={entries}
                        sessionId={sessionId}
                        api={api}
                        disabled={disabled}
                        onUpdate={(entry, text, attachments) => attachments === undefined
                            ? onUpdate(entry.id, text)
                            : onUpdate(entry.id, text, attachments)}
                        onReorder={onReorder}
                        onDelete={handleDelete}
                        onSend={onSend}
                        onSchedule={onSchedule}
                        listMarginClassName="mt-2"
                        emptyMarginClassName="mt-2"
                    />
                </div>
            </div>
        </div>
    )
}

/**
 * Per-session scratchlist (issue #11) -- the operator's "workbench".
 *
 * Distinct from the queue (`QueuedMessagesBar`):
 * - Queue = conveyor belt: messages auto-fire in order once the agent is idle.
 * - Scratchlist = workbench: notes / drafts / parking-lot ideas held until the
 *   operator edits, copies, deletes, or otherwise acts on them.
 *
 * The "held -- not sent" pill plus a subtle amber border is the visual
 * signal that nothing here is being sent without an explicit action. The
 * panel surface mirrors the user-message chat surface so it stays calm in
 * the scroll; the strong amber destination signal lives on the composer
 * Send button (which only goes amber while scratchlist mode is routing).
 */
export function ScratchlistPanel({
    sessionId,
}: {
    sessionId: string
}) {
    const { t } = useTranslation()
    const [entries, setEntries] = useState<ScratchlistEntry[]>(() => readScratchlist(sessionId))
    const [collapsed, setCollapsed] = useState<boolean>(() => readCollapsedPref(sessionId))
    const [draft, setDraft] = useState<string>('')
    const inputRef = useRef<HTMLTextAreaElement | null>(null)

    // Re-hydrate when the session id changes (route navigation between sessions).
    useEffect(() => {
        setEntries(readScratchlist(sessionId))
        setCollapsed(readCollapsedPref(sessionId))
        setDraft('')
    }, [sessionId])

    // Persist on every change. The storage layer swallows quota / serialization
    // errors so this won't throw.
    useEffect(() => {
        persistScratchlist(sessionId, entries)
    }, [sessionId, entries])

    // Global keyboard shortcut: Ctrl/Cmd + Shift + S focuses the add-input
    // and expands the panel. Suggested by the handoff doc; matches the
    // convention used by other composer-adjacent shortcuts (Ctrl/Cmd-m for
    // model cycling) so it shouldn't collide with browser defaults that the
    // app cares about.
    useEffect(() => {
        const onKeyDown = (e: globalThis.KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'S' || e.key === 's')) {
                e.preventDefault()
                setCollapsed(false)
                writeCollapsedPref(sessionId, false)
                queueMicrotask(() => inputRef.current?.focus())
            }
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
    }, [sessionId])

    const toggleCollapsed = useCallback(() => {
        setCollapsed((prev) => {
            const next = !prev
            writeCollapsedPref(sessionId, next)
            return next
        })
    }, [sessionId])

    const handleAdd = useCallback((rawText: string) => {
        setEntries((prev) => addScratchlistEntry(prev, rawText).entries)
        setDraft('')
    }, [])

    const handleSubmit = useCallback((event: ReactFormEvent<HTMLFormElement>) => {
        event.preventDefault()
        handleAdd(draft)
    }, [draft, handleAdd])

    const handleKeyDown = useCallback((e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
        // Plain Enter adds; Shift+Enter inserts a newline. Mirrors the
        // composer's default keyboard-send behavior so muscle memory carries
        // over and reduces accidental newlines in scratchlist titles.
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            handleAdd(draft)
        }
    }, [draft, handleAdd])

    const handleDelete = useCallback((entry: ScratchlistEntry) => {
        setEntries((prev) => deleteScratchlistEntry(prev, entry.id))
    }, [])

    const handleUpdate = useCallback((
        entry: ScratchlistEntry,
        text: string,
        attachments?: ScratchlistAttachmentMetadata[],
    ) => {
        setEntries((prev) => updateScratchlistEntry(prev, entry.id, text, Date.now(), attachments))
    }, [])

    const handleReorder = useCallback((entryId: string, targetIndex: number) => {
        setEntries((prev) => reorderScratchlistEntry(prev, entryId, targetIndex))
    }, [])

    const summary = useMemo(() => {
        if (entries.length === 0) return t('scratchlist.empty')
        if (entries.length === 1) return t('scratchlist.count.one')
        return t('scratchlist.count.other', { n: entries.length })
    }, [entries.length, t])

    const hasReachedCap = entries.length >= SCRATCHLIST_MAX_ENTRIES

    return (
        <div className="mx-auto w-full max-w-content mb-1">
            <div
                className="rounded-lg border border-[var(--app-badge-warning-border)] bg-[var(--app-chat-user-surface-bg)]"
                data-testid="scratchlist-panel"
            >
                <button
                    type="button"
                    onClick={toggleCollapsed}
                    aria-expanded={!collapsed}
                    aria-controls={`scratchlist-body-${sessionId}`}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-[var(--app-fg)] hover:opacity-90"
                >
                    <ChevronIcon open={!collapsed} />
                    <NoteIcon />
                    <span className="flex-1 truncate">
                        {t('scratchlist.title')}
                    </span>
                    <span
                        className="rounded-full border border-[var(--app-border)] bg-[var(--app-bg)]/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--app-hint)]"
                        aria-hidden="true"
                    >
                        {t('scratchlist.heldLabel')}
                    </span>
                    <span className="text-[var(--app-hint)] text-[11px] tabular-nums">
                        {summary}
                    </span>
                </button>

                <div
                    id={`scratchlist-body-${sessionId}`}
                    className="collapsible-panel"
                    aria-hidden={collapsed}
                    {...(!collapsed ? { 'data-open': '' } : {})}
                >
                    {/*
                     * `inert` removes the inner controls from the focus and
                     * pointer-events tree (and the accessibility tree) while
                     * collapsed. CSS-only collapse left the textarea + buttons
                     * focusable under aria-hidden, which is the regression
                     * flagged by the upstream PR review (a11y violation:
                     * focusable descendants inside an aria-hidden subtree).
                     * Using inert preserves the grid-template-rows expand
                     * animation while keeping the collapsed body unreachable.
                     */}
                    <div className="collapsible-inner" inert={collapsed}>
                        <div className="px-3 pb-3">
                            <form onSubmit={handleSubmit} className="flex items-start gap-2">
                                <textarea
                                    ref={inputRef}
                                    value={draft}
                                    onChange={(e) => setDraft(e.target.value)}
                                    onKeyDown={handleKeyDown}
                                    rows={1}
                                    maxLength={SCRATCHLIST_MAX_TEXT_LENGTH}
                                    placeholder={t('scratchlist.addPlaceholder')}
                                    aria-label={t('scratchlist.addAriaLabel')}
                                    disabled={hasReachedCap}
                                    className="flex-1 min-w-0 resize-none rounded-md bg-[var(--app-bg)] px-2 py-1.5 text-sm text-[var(--app-fg)] placeholder-[var(--app-hint)] focus:outline-none focus:ring-1 focus:ring-[var(--app-link)] disabled:cursor-not-allowed disabled:opacity-50"
                                />
                                <button
                                    type="submit"
                                    disabled={hasReachedCap || draft.trim().length === 0}
                                    className="shrink-0 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-1.5 text-xs font-medium text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)] disabled:cursor-not-allowed disabled:opacity-40"
                                >
                                    {t('scratchlist.add')}
                                </button>
                            </form>
                            {hasReachedCap ? (
                                <p className="mt-1 text-[11px] text-[var(--app-hint)]">
                                    {t('scratchlist.atCap', { n: SCRATCHLIST_MAX_ENTRIES })}
                                </p>
                            ) : null}

                            <ScratchlistInventory
                                entries={entries}
                                onUpdate={handleUpdate}
                                onReorder={handleReorder}
                                onDelete={handleDelete}
                            />
                        </div>
                    </div>
                </div>
            </div>
        </div>
    )
}
