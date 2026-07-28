import {
    forwardRef,
    useCallback,
    useEffect,
    useImperativeHandle,
    useLayoutEffect,
    useRef,
    type ClipboardEvent as ReactClipboardEvent,
    type FormEvent as ReactFormEvent,
    type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import {
    COMPOSER_MENTION_MIRROR_CHAR,
    coalesceComposerSegments,
    deleteBackwardInComposerSegments,
    insertPlainTextInComposerSegments,
    insertSessionMentionInComposerSegments,
    mirrorComposerSegments,
    parseComposerSegments,
    serializeComposerSegments,
    type ComposerSegment,
    type ComposerSelection,
} from '@/lib/composerSegments'

export type RichComposerInputHandle = {
    focus: () => void
    insertSessionMention: (
        mention: { id: string; title: string },
        prefixes?: string[]
    ) => { text: string; selection: ComposerSelection }
    applyPlainSuggestion: (
        suggestionText: string,
        prefixes?: string[]
    ) => { text: string; selection: ComposerSelection }
}

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
}

function createMentionSpan(id: string, title: string): HTMLSpanElement {
    const span = document.createElement('span')
    span.contentEditable = 'false'
    span.dataset.sessionId = id
    span.dataset.sessionTitle = title
    span.dataset.composerMention = 'session'
    span.className =
        'mx-0.5 inline-flex max-w-[12rem] items-center truncate rounded-md bg-[var(--app-subtle-bg)] px-1.5 py-0.5 align-baseline text-[0.95em] font-medium text-[var(--app-link)]'
    span.textContent = `@${title || id.slice(0, 8)}`
    return span
}

function segmentsFromEditor(root: HTMLElement): ComposerSegment[] {
    const segments: ComposerSegment[] = []
    const walk = (node: Node) => {
        if (node.nodeType === Node.TEXT_NODE) {
            const text = node.textContent ?? ''
            if (text) segments.push({ type: 'text', text })
            return
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return
        const el = node as HTMLElement
        if (el.dataset.composerMention === 'session' && el.dataset.sessionId) {
            segments.push({
                type: 'session',
                id: el.dataset.sessionId,
                title: el.dataset.sessionTitle || el.dataset.sessionId.slice(0, 8),
            })
            return
        }
        if (el.tagName === 'BR') {
            segments.push({ type: 'text', text: '\n' })
            return
        }
        for (const child of Array.from(el.childNodes)) {
            walk(child)
        }
    }
    for (const child of Array.from(root.childNodes)) {
        walk(child)
    }
    return coalesceComposerSegments(segments)
}

function renderSegmentsToEditor(root: HTMLElement, segments: readonly ComposerSegment[]) {
    root.replaceChildren()
    for (const segment of segments) {
        if (segment.type === 'text') {
            const parts = segment.text.split('\n')
            parts.forEach((part, index) => {
                if (part) root.appendChild(document.createTextNode(part))
                if (index < parts.length - 1) root.appendChild(document.createElement('br'))
            })
            continue
        }
        root.appendChild(createMentionSpan(segment.id, segment.title))
    }
    if (root.childNodes.length === 0) {
        root.appendChild(document.createTextNode(''))
    }
}

function mirrorOffsetFromPoint(root: HTMLElement, endContainer: Node, endOffset: number): number {
    let count = 0

    const visit = (n: Node): boolean => {
        if (n === endContainer && n.nodeType === Node.TEXT_NODE) {
            count += endOffset
            return true
        }
        if (n.nodeType === Node.TEXT_NODE) {
            count += n.textContent?.length ?? 0
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
            const len = n.textContent?.length ?? 0
            if (remaining <= len) {
                place(n, remaining)
                return true
            }
            remaining -= len
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
    },
    ref
) {
    const rootRef = useRef<HTMLDivElement>(null)
    const lastEmittedRef = useRef(value)
    const composingRef = useRef(false)

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
        renderSegmentsToEditor(root, segments)
        lastEmittedRef.current = next
        const mirror = mirrorComposerSegments(segments)
        const sel = selection ?? { start: mirror.length, end: mirror.length }
        setMirrorSelection(root, sel)
        onMirrorChange({ text: mirror, selection: sel })
    }, [onMirrorChange])

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
        insertSessionMention: (mention, prefixes = ['@', '/', '$']) => {
            const root = rootRef.current
            if (!root) {
                return { text: value, selection: { start: value.length, end: value.length } }
            }
            const segments = segmentsFromEditor(root)
            const selection = getMirrorSelection(root)
            const result = insertSessionMentionInComposerSegments(segments, selection, mention, prefixes)
            const serialized = serializeComposerSegments(result.segments)
            renderSegmentsToEditor(root, result.segments)
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
            renderSegmentsToEditor(root, result.segments)
            lastEmittedRef.current = serialized
            setMirrorSelection(root, result.selection)
            onValueChange(serialized)
            onMirrorChange({
                text: mirrorComposerSegments(result.segments),
                selection: result.selection,
            })
            return { text: serialized, selection: result.selection }
        },
    }), [onMirrorChange, onValueChange, value])

    const handleInput = useCallback((_e: ReactFormEvent<HTMLDivElement>) => {
        if (composingRef.current) return
        onEdit?.()
        emitFromDom()
    }, [emitFromDom, onEdit])

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
                    const result = deleteBackwardInComposerSegments(segments, selection)
                    const serialized = serializeComposerSegments(result.segments)
                    renderSegmentsToEditor(root, result.segments)
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
    }, [onEdit, onKeyDown, onMirrorChange, onValueChange])

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
                contentEditable={!disabled}
                suppressContentEditableWarning
                data-testid="rich-composer-input"
                className={className}
                onInput={handleInput}
                onKeyDown={handleKeyDown}
                onPaste={onPaste}
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
        </div>
    )
})
