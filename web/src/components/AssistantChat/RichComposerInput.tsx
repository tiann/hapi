import {
    forwardRef,
    useCallback,
    useEffect,
    useImperativeHandle,
    useLayoutEffect,
    useRef,
    useState,
    type ClipboardEvent as ReactClipboardEvent,
    type FormEvent as ReactFormEvent,
    type KeyboardEvent as ReactKeyboardEvent,
    type PointerEvent as ReactPointerEvent,
} from 'react'
import { createPortal } from 'react-dom'
import {
    COMPOSER_MENTION_MIRROR_CHAR,
    coalesceComposerSegments,
    deleteBackwardInComposerSegments,
    insertPlainTextInComposerSegments,
    insertSegmentsInComposerSegments,
    insertSessionMentionInComposerSegments,
    mirrorComposerSegments,
    parseComposerSegments,
    serializeComposerSegments,
    serializeComposerSelection,
    type ComposerSegment,
    type ComposerSelection,
} from '@/lib/composerSegments'
import {
    formatSessionMentionTooltip,
    type SessionMentionTooltipModel,
} from '@/lib/sessionReference'
import { SessionRowSummary } from '@/components/SessionRowSummary'
import type { SessionSummary } from '@/types/api'

export type RichComposerInputHandle = {
    focus: () => void
    /**
     * Re-read the contenteditable → serialize session chips to
     * `[title](/sessions/<id>)` and push into composer state. Call before
     * send so the agent prompt never gets chip-visible `@title` alone.
     */
    flushSerializedText: () => string
    insertSessionMention: (
        mention: { id: string; title: string },
        prefixes?: string[]
    ) => { text: string; selection: ComposerSelection }
    applyPlainSuggestion: (
        suggestionText: string,
        prefixes?: string[]
    ) => { text: string; selection: ComposerSelection }
}

export type SessionMentionResolveResult = {
    model: SessionMentionTooltipModel
    /** Live row for sidebar-parity chip tooltip; null → fallback text tip. */
    session: SessionSummary | null
}

type ResolveSessionMentionTooltip = (
    id: string,
    title: string
) => SessionMentionResolveResult

type Props = {
    value: string
    disabled?: boolean
    placeholder?: string
    className?: string
    autoFocus?: boolean
    onValueChange: (value: string) => void
    onMirrorChange: (state: { text: string; selection: ComposerSelection }) => void
    onKeyDown?: (e: ReactKeyboardEvent<HTMLDivElement>) => void
    onPaste?: (e: ReactClipboardEvent<HTMLDivElement>) => void
    onEdit?: () => void
    /** Live session meta for chip hover / aria-label (from useSessions). */
    resolveSessionMentionTooltip?: ResolveSessionMentionTooltip
}

type MentionTooltipState = {
    model: SessionMentionTooltipModel
    session: SessionSummary | null
    top: number
    left: number
}

function createMentionSpan(
    id: string,
    title: string,
    resolveTooltip?: ResolveSessionMentionTooltip
): HTMLSpanElement {
    const span = document.createElement('span')
    span.contentEditable = 'false'
    span.dataset.sessionId = id
    span.dataset.sessionTitle = title
    span.dataset.composerMention = 'session'
    span.className =
        'mx-0.5 inline-flex max-w-[12rem] items-center truncate rounded-md bg-[var(--app-subtle-bg)] px-1.5 py-0.5 align-baseline text-[0.95em] font-medium text-[var(--app-link)]'
    span.textContent = `@${title || id.slice(0, 8)}`
    const tip = resolveTooltip?.(id, title)?.model
        ?? formatSessionMentionTooltip(null, title, id)
    span.setAttribute('aria-label', tip.ariaLabel)
    return span
}

const BLOCK_TAGS = new Set(['DIV', 'P', 'LI', 'TR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE'])
/** Zero-width pad so a trailing linebreak keeps a caret line-box (pre-wrap / br). */
const CARET_PAD = '\u200B'

function stripCaretPad(text: string): string {
    return text.replaceAll(CARET_PAD, '')
}

/** Exported for unit tests — maps contenteditable DOM → composer segments. */
export function segmentsFromEditor(root: HTMLElement): ComposerSegment[] {
    const segments: ComposerSegment[] = []
    let pendingBlockBreak = false

    const pushText = (text: string) => {
        const cleaned = stripCaretPad(text)
        if (!cleaned) return
        segments.push({ type: 'text', text: cleaned })
    }

    const pushNewlineIfNeeded = () => {
        if (!pendingBlockBreak) return
        if (segments.length === 0) {
            pendingBlockBreak = false
            return
        }
        pushText('\n')
        pendingBlockBreak = false
    }

    const walk = (node: Node) => {
        if (node.nodeType === Node.TEXT_NODE) {
            pushNewlineIfNeeded()
            pushText(node.textContent ?? '')
            return
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return
        const el = node as HTMLElement
        // Session chips are atomic. Never walk their visible `@title` text —
        // that would strip the id from the agent prompt on send.
        if (el.dataset.composerMention === 'session') {
            pushNewlineIfNeeded()
            const id = el.dataset.sessionId?.trim()
            if (id) {
                segments.push({
                    type: 'session',
                    id,
                    title: el.dataset.sessionTitle || id.slice(0, 8),
                })
            }
            // Orphan chip (missing id): drop it rather than emit title-only.
            return
        }
        if (el.tagName === 'BR') {
            pushNewlineIfNeeded()
            pushText('\n')
            return
        }
        const isBlock = BLOCK_TAGS.has(el.tagName)
        // Any block after existing content (Chrome Enter, pasted <p>/<li>, nested
        // wrappers) → newline. Depth-agnostic so paste wrappers do not collapse.
        if (isBlock && segments.length > 0) {
            pendingBlockBreak = true
        }
        for (const child of Array.from(el.childNodes)) {
            walk(child)
        }
        if (isBlock) {
            pendingBlockBreak = true
        }
    }
    for (const child of Array.from(root.childNodes)) {
        walk(child)
    }
    return coalesceComposerSegments(segments)
}

/**
 * True when some node after `from` carries mirror-visible content.
 * Range.insertNode splits the caret's text node, so a bare `\n` at EOL always
 * has an empty Text nextSibling — `!nextSibling` is the wrong at-end test.
 */
function hasMeaningfulTrailingAfter(from: Node): boolean {
    for (let n: Node | null = from.nextSibling; n; n = n.nextSibling) {
        if (n.nodeType === Node.TEXT_NODE) {
            if (stripCaretPad(n.textContent ?? '')) return true
            continue
        }
        return true
    }
    return false
}

/**
 * Insert a single mirror newline at the caret. Prefer this over execCommand
 * ('insertLineBreak'): in plaintext-only / pre-wrap Chromium inserts two `\n`
 * text nodes (placeholder), which serializes as `\n\n` on the wire.
 * Manual `\n` + CARET_PAD gives the same line-box height and serializes once.
 * Exported for jsdom coverage of the EOL pad path.
 */
export function insertLineBreakAtCaret(root: HTMLElement): void {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return

    root.focus()
    const range = sel.getRangeAt(0)
    range.deleteContents()
    const nl = document.createTextNode('\n')
    range.insertNode(nl)
    if (!hasMeaningfulTrailingAfter(nl)) {
        const pad = document.createTextNode(CARET_PAD)
        nl.parentNode?.insertBefore(pad, nl.nextSibling)
        range.setStart(pad, pad.length)
    } else {
        range.setStart(nl, nl.length)
    }
    range.collapse(true)
    sel.removeAllRanges()
    sel.addRange(range)
}

function renderSegmentsToEditor(
    root: HTMLElement,
    segments: readonly ComposerSegment[],
    resolveTooltip?: ResolveSessionMentionTooltip
) {
    root.replaceChildren()
    for (const segment of segments) {
        if (segment.type === 'text') {
            const parts = segment.text.split('\n')
            parts.forEach((part, index) => {
                if (part) root.appendChild(document.createTextNode(part))
                if (index < parts.length - 1) root.appendChild(document.createElement('br'))
            })
            // Trailing newline needs a caret target or the new line is invisible.
            if (segment.text.endsWith('\n')) {
                root.appendChild(document.createTextNode(CARET_PAD))
            }
            continue
        }
        root.appendChild(createMentionSpan(segment.id, segment.title, resolveTooltip))
    }
    if (root.childNodes.length === 0) {
        root.appendChild(document.createTextNode(''))
    }
}

/** Exported for unit tests — maps a DOM caret point into mirror-string offset. */
export function mirrorOffsetFromPoint(root: HTMLElement, endContainer: Node, endOffset: number): number {
    let count = 0

    const visit = (n: Node): boolean => {
        if (n === endContainer && n.nodeType === Node.TEXT_NODE) {
            const raw = n.textContent ?? ''
            count += stripCaretPad(raw.slice(0, endOffset)).length
            return true
        }
        if (n.nodeType === Node.TEXT_NODE) {
            count += stripCaretPad(n.textContent ?? '').length
            return false
        }
        if (n.nodeType !== Node.ELEMENT_NODE) return false
        const el = n as HTMLElement
        if (el.dataset.composerMention === 'session') {
            if (n === endContainer) {
                count += endOffset > 0 ? 1 : 0
                return true
            }
            count += 1
            return false
        }
        if (el.tagName === 'BR') {
            if (n === endContainer) return true
            count += 1
            return false
        }
        if (n === endContainer) {
            const children = Array.from(n.childNodes)
            for (let i = 0; i < endOffset && i < children.length; i++) {
                if (visit(children[i]!)) return true
            }
            return true
        }
        for (const child of Array.from(n.childNodes)) {
            if (visit(child)) return true
        }
        return false
    }

    // Root-anchored ranges (caret before a leading chip, select-all) report
    // endContainer === root; visit only children of that offset.
    if (endContainer === root) {
        const children = Array.from(root.childNodes)
        for (let i = 0; i < endOffset && i < children.length; i++) {
            visit(children[i]!)
        }
        return count
    }

    for (const child of Array.from(root.childNodes)) {
        if (visit(child)) break
    }
    return count
}

function getMirrorSelection(root: HTMLElement): ComposerSelection {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) {
        const len = mirrorComposerSegments(segmentsFromEditor(root)).length
        return { start: len, end: len }
    }
    const range = sel.getRangeAt(0)
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) {
        const len = mirrorComposerSegments(segmentsFromEditor(root)).length
        return { start: len, end: len }
    }
    const start = mirrorOffsetFromPoint(root, range.startContainer, range.startOffset)
    const end = mirrorOffsetFromPoint(root, range.endContainer, range.endOffset)
    return { start: Math.min(start, end), end: Math.max(start, end) }
}

function setMirrorSelection(root: HTMLElement, selection: ComposerSelection) {
    const target = Math.max(0, selection.start)
    let remaining = target
    const sel = window.getSelection()
    if (!sel) return

    const place = (node: Node, offset: number) => {
        const range = document.createRange()
        range.setStart(node, offset)
        range.collapse(true)
        sel.removeAllRanges()
        sel.addRange(range)
    }

    const walk = (n: Node): boolean => {
        if (n.nodeType === Node.TEXT_NODE) {
            const raw = n.textContent ?? ''
            // Caret-pad ZWSP is not part of the mirror; still a valid caret target.
            if (raw === CARET_PAD) {
                if (remaining === 0) {
                    place(n, raw.length)
                    return true
                }
                return false
            }
            const cleaned = stripCaretPad(raw)
            if (remaining <= cleaned.length) {
                // Map cleaned offset back into raw (pads have mirror width 0).
                let cleanedSeen = 0
                let rawOffset = 0
                while (rawOffset < raw.length && cleanedSeen < remaining) {
                    if (raw[rawOffset] !== CARET_PAD) cleanedSeen += 1
                    rawOffset += 1
                }
                place(n, rawOffset)
                return true
            }
            remaining -= cleaned.length
            return false
        }
        if (n.nodeType !== Node.ELEMENT_NODE) return false
        const el = n as HTMLElement
        if (el.dataset.composerMention === 'session') {
            const parent = el.parentNode
            if (!parent) return true
            const index = Array.from(parent.childNodes).indexOf(el)
            if (remaining === 0) {
                place(parent, index)
                return true
            }
            if (remaining === 1) {
                place(parent, index + 1)
                return true
            }
            remaining -= 1
            return false
        }
        if (el.tagName === 'BR') {
            const parent = el.parentNode
            if (!parent) return true
            if (remaining === 0) {
                place(parent, Array.from(parent.childNodes).indexOf(el))
                return true
            }
            remaining -= 1
            return false
        }
        for (const child of Array.from(n.childNodes)) {
            if (walk(child)) return true
        }
        return false
    }

    for (const child of Array.from(root.childNodes)) {
        if (walk(child)) return
    }
    place(root, root.childNodes.length)
}

const MENTION_TOOLTIP_DELAY_MS = 300

/** Lazily probed once — Firefox <136 treats unknown values as inherit (not editable). */
let supportsPlaintextOnlyCached: boolean | null = null

function supportsPlaintextOnly(): boolean {
    if (supportsPlaintextOnlyCached !== null) return supportsPlaintextOnlyCached
    if (typeof document === 'undefined') {
        supportsPlaintextOnlyCached = false
        return false
    }
    try {
        const probe = document.createElement('div')
        probe.contentEditable = 'plaintext-only'
        supportsPlaintextOnlyCached = probe.contentEditable === 'plaintext-only'
    } catch {
        supportsPlaintextOnlyCached = false
    }
    return supportsPlaintextOnlyCached
}

function contentEditableValue(disabled: boolean): boolean | 'plaintext-only' {
    if (disabled) return false
    return supportsPlaintextOnly() ? 'plaintext-only' : true
}

export const RichComposerInput = forwardRef<RichComposerInputHandle, Props>(function RichComposerInput(
    {
        value,
        disabled = false,
        placeholder,
        className,
        autoFocus = false,
        onValueChange,
        onMirrorChange,
        onKeyDown,
        onPaste,
        onEdit,
        resolveSessionMentionTooltip,
    },
    ref
) {
    const rootRef = useRef<HTMLDivElement>(null)
    // null until first sync/emit so mount-time `value` always paints into the DOM.
    const lastEmittedRef = useRef<string | null>(null)
    const composingRef = useRef(false)
    const tooltipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const hoveredChipRef = useRef<HTMLElement | null>(null)
    const [mentionTooltip, setMentionTooltip] = useState<MentionTooltipState | null>(null)

    const clearMentionTooltip = useCallback(() => {
        if (tooltipTimerRef.current) {
            clearTimeout(tooltipTimerRef.current)
            tooltipTimerRef.current = null
        }
        hoveredChipRef.current = null
        setMentionTooltip(null)
    }, [])

    const emitFromDom = useCallback(() => {
        const root = rootRef.current
        if (!root) return
        const segments = segmentsFromEditor(root)
        const serialized = serializeComposerSegments(segments)
        const selection = getMirrorSelection(root)
        const mirror = mirrorComposerSegments(segments)
        lastEmittedRef.current = serialized
        onValueChange(serialized)
        onMirrorChange({ text: mirror, selection })
    }, [onMirrorChange, onValueChange])

    const syncFromValue = useCallback((next: string, selection?: ComposerSelection) => {
        const root = rootRef.current
        if (!root) return
        const segments = parseComposerSegments(next)
        renderSegmentsToEditor(root, segments, resolveSessionMentionTooltip)
        lastEmittedRef.current = next
        clearMentionTooltip()
        const mirror = mirrorComposerSegments(segments)
        const sel = selection ?? { start: mirror.length, end: mirror.length }
        // Placing a Selection inside contenteditable focuses it in Blink/WebKit —
        // skip when the editor is not already focused (draft restore / queue edit).
        const hadFocus = root.contains(document.activeElement)
        if (hadFocus || selection) {
            setMirrorSelection(root, sel)
        }
        onMirrorChange({ text: mirror, selection: sel })
    }, [clearMentionTooltip, onMirrorChange, resolveSessionMentionTooltip])

    useLayoutEffect(() => {
        if (value === lastEmittedRef.current) return
        syncFromValue(value)
    }, [value, syncFromValue])

    useEffect(() => {
        if (!autoFocus || disabled) return
        const root = rootRef.current
        if (!root) return
        try {
            root.focus({ preventScroll: true })
        } catch {
            root.focus()
        }
    }, [autoFocus, disabled])

    useImperativeHandle(ref, () => ({
        focus: () => {
            rootRef.current?.focus()
        },
        flushSerializedText: () => {
            const root = rootRef.current
            if (!root) return value
            const segments = segmentsFromEditor(root)
            const serialized = serializeComposerSegments(segments)
            lastEmittedRef.current = serialized
            onValueChange(serialized)
            onMirrorChange({
                text: mirrorComposerSegments(segments),
                selection: getMirrorSelection(root),
            })
            return serialized
        },
        insertSessionMention: (mention, prefixes = ['@', '/', '$']) => {
            const root = rootRef.current
            if (!root) {
                return { text: value, selection: { start: value.length, end: value.length } }
            }
            const segments = segmentsFromEditor(root)
            const selection = getMirrorSelection(root)
            const result = insertSessionMentionInComposerSegments(segments, selection, mention, prefixes)
            const serialized = serializeComposerSegments(result.segments)
            renderSegmentsToEditor(root, result.segments, resolveSessionMentionTooltip)
            lastEmittedRef.current = serialized
            setMirrorSelection(root, result.selection)
            onValueChange(serialized)
            onMirrorChange({
                text: mirrorComposerSegments(result.segments),
                selection: result.selection,
            })
            return { text: serialized, selection: result.selection }
        },
        applyPlainSuggestion: (suggestionText, prefixes = ['@', '/', '$']) => {
            const root = rootRef.current
            if (!root) {
                return { text: value, selection: { start: value.length, end: value.length } }
            }
            const segments = segmentsFromEditor(root)
            const selection = getMirrorSelection(root)
            const result = insertPlainTextInComposerSegments(segments, selection, suggestionText, prefixes)
            const serialized = serializeComposerSegments(result.segments)
            renderSegmentsToEditor(root, result.segments, resolveSessionMentionTooltip)
            lastEmittedRef.current = serialized
            setMirrorSelection(root, result.selection)
            onValueChange(serialized)
            onMirrorChange({
                text: mirrorComposerSegments(result.segments),
                selection: result.selection,
            })
            return { text: serialized, selection: result.selection }
        },
    }), [onMirrorChange, onValueChange, resolveSessionMentionTooltip, value])

    useEffect(() => () => {
        if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current)
    }, [])

    // While open, poll hit-test: contenteditable pointerout/relatedTarget is flaky
    // (chip → prose / outside often never clears). elementFromPoint is the truth.
    useEffect(() => {
        if (!mentionTooltip) return
        const onMove = (ev: PointerEvent) => {
            if (ev.pointerType === 'touch') return
            const chip = hoveredChipRef.current
            if (!chip || !chip.isConnected) {
                clearMentionTooltip()
                return
            }
            const el = document.elementFromPoint(ev.clientX, ev.clientY)
            if (!el || !chip.contains(el)) {
                clearMentionTooltip()
            }
        }
        const dismiss = () => clearMentionTooltip()
        window.addEventListener('pointermove', onMove, { passive: true })
        window.addEventListener('scroll', dismiss, { capture: true, passive: true })
        window.addEventListener('resize', dismiss, { passive: true })
        return () => {
            window.removeEventListener('pointermove', onMove)
            window.removeEventListener('scroll', dismiss, true)
            window.removeEventListener('resize', dismiss)
        }
    }, [mentionTooltip, clearMentionTooltip])

    const showMentionTooltipForChip = useCallback((chip: HTMLElement) => {
        const id = chip.dataset.sessionId
        if (!id) return
        const title = chip.dataset.sessionTitle || id.slice(0, 8)
        const resolved = resolveSessionMentionTooltip?.(id, title)
        const model = resolved?.model ?? formatSessionMentionTooltip(null, title, id)
        chip.setAttribute('aria-label', model.ariaLabel)
        hoveredChipRef.current = chip
        if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current)
        tooltipTimerRef.current = setTimeout(() => {
            if (hoveredChipRef.current !== chip || !chip.isConnected) return
            const rect = chip.getBoundingClientRect()
            setMentionTooltip({
                model,
                session: resolved?.session ?? null,
                top: rect.top - 8,
                left: rect.left + rect.width / 2,
            })
        }, MENTION_TOOLTIP_DELAY_MS)
    }, [resolveSessionMentionTooltip])

    const handlePointerOver = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
        // Touch: no bubble (matches HoverTooltip). Mouse/pen only.
        if (e.pointerType === 'touch') return
        const chip = (e.target as HTMLElement | null)?.closest?.(
            '[data-composer-mention="session"]'
        ) as HTMLElement | null
        if (!chip || !rootRef.current?.contains(chip)) {
            // Over editor prose / empty space — dismiss any open chip tip.
            if (hoveredChipRef.current) clearMentionTooltip()
            return
        }
        if (hoveredChipRef.current === chip) return
        showMentionTooltipForChip(chip)
    }, [clearMentionTooltip, showMentionTooltipForChip])

    const handlePointerLeave = useCallback(() => {
        // Leaving the editor root entirely (does not fire for chip→prose moves).
        clearMentionTooltip()
    }, [clearMentionTooltip])

    const handleInput = useCallback((_e: ReactFormEvent<HTMLDivElement>) => {
        clearMentionTooltip()
        if (composingRef.current) return
        onEdit?.()
        emitFromDom()
    }, [clearMentionTooltip, emitFromDom, onEdit])

    const insertPlainClipboardText = useCallback((text: string) => {
        const root = rootRef.current
        if (!root || !text) return
        const segments = segmentsFromEditor(root)
        const selection = getMirrorSelection(root)
        // Parse wire markdown so `[title](/sessions/<id>)` paste restores chips
        // (copy/cut put that format on the clipboard). Plain prose stays text.
        const result = insertSegmentsInComposerSegments(
            segments,
            selection,
            parseComposerSegments(text),
        )
        const serialized = serializeComposerSegments(result.segments)
        renderSegmentsToEditor(root, result.segments, resolveSessionMentionTooltip)
        lastEmittedRef.current = serialized
        setMirrorSelection(root, result.selection)
        onValueChange(serialized)
        onMirrorChange({
            text: mirrorComposerSegments(result.segments),
            selection: result.selection,
        })
        onEdit?.()
    }, [onEdit, onMirrorChange, onValueChange, resolveSessionMentionTooltip])

    const handleCopyOrCut = useCallback((e: ReactClipboardEvent<HTMLDivElement>, cut: boolean) => {
        const root = rootRef.current
        if (!root) return
        const segments = segmentsFromEditor(root)
        const selection = getMirrorSelection(root)
        const text = serializeComposerSelection(segments, selection)
        if (text === null) return
        e.preventDefault()
        e.clipboardData.setData('text/plain', text)
        if (!cut) return
        clearMentionTooltip()
        const result = deleteBackwardInComposerSegments(segments, selection)
        const serialized = serializeComposerSegments(result.segments)
        renderSegmentsToEditor(root, result.segments, resolveSessionMentionTooltip)
        lastEmittedRef.current = serialized
        setMirrorSelection(root, result.selection)
        onValueChange(serialized)
        onMirrorChange({
            text: mirrorComposerSegments(result.segments),
            selection: result.selection,
        })
        onEdit?.()
    }, [
        clearMentionTooltip,
        onEdit,
        onMirrorChange,
        onValueChange,
        resolveSessionMentionTooltip,
    ])

    const handlePaste = useCallback((e: ReactClipboardEvent<HTMLDivElement>) => {
        const files = Array.from(e.clipboardData?.files ?? [])
        const hasImage = files.some((file) => file.type.startsWith('image/'))
        if (hasImage) {
            onPaste?.(e)
            return
        }
        // Contenteditable default paste inserts HTML; nested blocks collapse in
        // segmentsFromEditor without depth-aware breaks. Force plain text.
        e.preventDefault()
        insertPlainClipboardText(e.clipboardData?.getData('text/plain') ?? '')
    }, [insertPlainClipboardText, onPaste])

    // No onDrop: intercepting without caretRangeFromPoint appends at EOF / no-ops
    // in-editor moves. Native CE drop + plaintext-only / paste path is enough for #1215.

    const handleKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
        if (e.nativeEvent.isComposing) {
            onKeyDown?.(e)
            return
        }
        if (e.key === 'Backspace' && !e.metaKey && !e.ctrlKey && !e.altKey) {
            const root = rootRef.current
            if (root) {
                const segments = segmentsFromEditor(root)
                const selection = getMirrorSelection(root)
                const mirror = mirrorComposerSegments(segments)
                const againstAtom =
                    selection.start === selection.end
                    && selection.start > 0
                    && mirror[selection.start - 1] === COMPOSER_MENTION_MIRROR_CHAR
                if (againstAtom || selection.start !== selection.end) {
                    e.preventDefault()
                    clearMentionTooltip()
                    const result = deleteBackwardInComposerSegments(segments, selection)
                    const serialized = serializeComposerSegments(result.segments)
                    renderSegmentsToEditor(root, result.segments, resolveSessionMentionTooltip)
                    lastEmittedRef.current = serialized
                    setMirrorSelection(root, result.selection)
                    onValueChange(serialized)
                    onMirrorChange({
                        text: mirrorComposerSegments(result.segments),
                        selection: result.selection,
                    })
                    onEdit?.()
                    return
                }
            }
        }
        onKeyDown?.(e)
        // Parent handles suggestion-select / send with preventDefault. If Enter
        // was left alone (Shift+Enter, or Enter-inserts-newline mode), insert a
        // <br> instead of letting Chromium split the editor into block <div>s
        // that would collapse to "line1line2" on serialize.
        // Any Enter the parent left unprevented (incl. Alt/Ctrl when !canSend) must
        // become a <br> — never Chromium block <div>s (offset/serialize footguns).
        if (!e.defaultPrevented && e.key === 'Enter') {
            const root = rootRef.current
            if (!root) return
            e.preventDefault()
            insertLineBreakAtCaret(root)
            onEdit?.()
            emitFromDom()
        }
    }, [
        emitFromDom,
        onEdit,
        onKeyDown,
        onMirrorChange,
        onValueChange,
        resolveSessionMentionTooltip,
        clearMentionTooltip,
    ])

    return (
        <div className="relative min-w-0 flex-1">
            {(!value || value.length === 0) && placeholder ? (
                <div
                    aria-hidden
                    className="pointer-events-none absolute inset-0 text-base leading-snug text-[var(--app-hint)]"
                >
                    {placeholder}
                </div>
            ) : null}
            <div
                ref={rootRef}
                role="textbox"
                aria-multiline="true"
                aria-label={placeholder}
                aria-disabled={disabled || undefined}
                // Prefer plaintext-only when the engine accepts it (Chrome/Safari/FF136+);
                // handlePaste still forces text/plain for engines that keep HTML paste.
                contentEditable={contentEditableValue(disabled)}
                suppressContentEditableWarning
                data-testid="rich-composer-input"
                className={`${className ?? ''}${disabled ? ' cursor-not-allowed opacity-50' : ''}`}
                onInput={handleInput}
                onKeyDown={handleKeyDown}
                onPointerOver={handlePointerOver}
                onPointerLeave={handlePointerLeave}
                onCopy={(e) => handleCopyOrCut(e, false)}
                onCut={(e) => handleCopyOrCut(e, true)}
                onPaste={handlePaste}
                onCompositionStart={() => {
                    composingRef.current = true
                }}
                onCompositionEnd={() => {
                    composingRef.current = false
                    onEdit?.()
                    emitFromDom()
                }}
                onKeyUp={() => {
                    const root = rootRef.current
                    if (!root || composingRef.current) return
                    const segments = segmentsFromEditor(root)
                    onMirrorChange({
                        text: mirrorComposerSegments(segments),
                        selection: getMirrorSelection(root),
                    })
                }}
                onMouseUp={() => {
                    const root = rootRef.current
                    if (!root) return
                    const segments = segmentsFromEditor(root)
                    onMirrorChange({
                        text: mirrorComposerSegments(segments),
                        selection: getMirrorSelection(root),
                    })
                }}
            />
            {mentionTooltip && typeof document !== 'undefined'
                ? createPortal(
                    <div
                        role="tooltip"
                        data-testid="rich-composer-mention-tooltip"
                        className="pointer-events-none fixed z-[80] w-[min(20rem,calc(100vw-1.5rem))] -translate-x-1/2 -translate-y-full rounded-lg border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-2.5 py-2 text-[var(--app-fg)] shadow-lg"
                        style={{ top: mentionTooltip.top, left: mentionTooltip.left }}
                    >
                        {mentionTooltip.session ? (
                            <SessionRowSummary
                                session={mentionTooltip.session}
                                showDetailedStatus
                                nestedTooltips={false}
                            />
                        ) : (
                            <>
                                <span className="block text-sm font-medium">
                                    {mentionTooltip.model.title}
                                </span>
                                {mentionTooltip.model.lines.map((line) => (
                                    <span
                                        key={line}
                                        className="mt-0.5 block break-words text-xs text-[var(--app-hint)]"
                                    >
                                        {line}
                                    </span>
                                ))}
                            </>
                        )}
                    </div>,
                    document.body
                )
                : null}
        </div>
    )
})
