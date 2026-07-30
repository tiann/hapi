import { buildSessionReferencePath, parseSessionPathHref } from '@/lib/sessionReference'
import { findActiveWord } from '@/utils/findActiveWord'

/** Object Replacement Character — one mirror slot per session atom. */
export const COMPOSER_MENTION_MIRROR_CHAR = '\uFFFC'

export type ComposerTextSegment = {
    type: 'text'
    text: string
}

export type ComposerSessionSegment = {
    type: 'session'
    id: string
    title: string
}

export type ComposerSegment = ComposerTextSegment | ComposerSessionSegment

export type ComposerSelection = {
    start: number
    end: number
}

function sanitizeMentionTitle(title: string): string {
    return title.replace(/\s+/g, ' ').trim().slice(0, 120)
}

function escapeMarkdownLinkLabel(title: string): string {
    return sanitizeMentionTitle(title).replace(/\\/g, '\\\\').replace(/\[/g, '\\[').replace(/\]/g, '\\]')
}

function unescapeMarkdownLinkLabel(label: string): string {
    return label.replace(/\\([\\\[\]])/g, '$1')
}

/**
 * Wire format for send / drafts / send-error restore.
 * Session atoms become `[title](/sessions/<id>)` so the agent prompt includes
 * the full session id (not chip-visible `@title` alone). Hub + CLI pass this
 * string through unchanged to every agent flavor.
 */
export function serializeComposerSegments(segments: readonly ComposerSegment[]): string {
    let out = ''
    for (const segment of segments) {
        if (segment.type === 'text') {
            out += segment.text
            continue
        }
        const id = segment.id.trim()
        if (!id) continue
        const path = buildSessionReferencePath(id)
        const label = escapeMarkdownLinkLabel(segment.title) || id.slice(0, 8)
        out += `[${label}](${path})`
    }
    return out
}

/**
 * Editing mirror: text as-is, each session atom as a single `\uFFFC`.
 * Selection offsets for insert/delete/activeWord live in this space.
 */
export function mirrorComposerSegments(segments: readonly ComposerSegment[]): string {
    let out = ''
    for (const segment of segments) {
        out += segment.type === 'text' ? segment.text : COMPOSER_MENTION_MIRROR_CHAR
    }
    return out
}

const SESSION_MD_LINK_RE = /\[((?:\\.|[^\]\\])*)\]\(([^)]+)\)/g

/** Parse serialized composer text back into segments (session markdown links → atoms). */
export function parseComposerSegments(source: string): ComposerSegment[] {
    if (!source) return [{ type: 'text', text: '' }]

    const segments: ComposerSegment[] = []
    let cursor = 0
    SESSION_MD_LINK_RE.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = SESSION_MD_LINK_RE.exec(source)) !== null) {
        const href = match[2] ?? ''
        const sessionId = parseSessionPathHref(href)
        if (!sessionId) continue

        const start = match.index
        if (start > cursor) {
            segments.push({ type: 'text', text: source.slice(cursor, start) })
        }
        segments.push({
            type: 'session',
            id: sessionId,
            title: unescapeMarkdownLinkLabel(match[1] ?? '') || sessionId.slice(0, 8),
        })
        cursor = start + match[0].length
    }
    if (cursor < source.length) {
        segments.push({ type: 'text', text: source.slice(cursor) })
    }
    if (segments.length === 0) {
        return [{ type: 'text', text: source }]
    }
    return coalesceComposerSegments(segments)
}

export function coalesceComposerSegments(segments: readonly ComposerSegment[]): ComposerSegment[] {
    const out: ComposerSegment[] = []
    for (const segment of segments) {
        if (segment.type === 'text' && segment.text.length === 0) continue
        const prev = out[out.length - 1]
        if (segment.type === 'text' && prev?.type === 'text') {
            prev.text += segment.text
            continue
        }
        out.push(segment.type === 'text' ? { type: 'text', text: segment.text } : { ...segment })
    }
    if (out.length === 0) return [{ type: 'text', text: '' }]
    return out
}

function cloneComposerSegment(segment: ComposerSegment): ComposerSegment {
    return segment.type === 'text'
        ? { type: 'text', text: segment.text }
        : { type: 'session', id: segment.id, title: segment.title }
}

export function splitMirrorAt(
    segments: readonly ComposerSegment[],
    offset: number
): { before: ComposerSegment[]; after: ComposerSegment[] } {
    let remaining = Math.max(0, offset)
    const before: ComposerSegment[] = []
    const after: ComposerSegment[] = []
    for (let i = 0; i < segments.length; i++) {
        const segment = segments[i]!
        const len = segment.type === 'text' ? segment.text.length : 1
        if (remaining > len) {
            before.push(cloneComposerSegment(segment))
            remaining -= len
            continue
        }
        if (segment.type === 'session') {
            if (remaining === 0) {
                after.push(cloneComposerSegment(segment), ...segments.slice(i + 1).map(cloneComposerSegment))
            } else {
                // caret inside atom — treat as after the atom
                before.push(cloneComposerSegment(segment))
                after.push(...segments.slice(i + 1).map(cloneComposerSegment))
            }
            return { before: coalesceComposerSegments(before), after: coalesceComposerSegments(after) }
        }
        const left = segment.text.slice(0, remaining)
        const right = segment.text.slice(remaining)
        if (left) before.push({ type: 'text', text: left })
        if (right) after.push({ type: 'text', text: right })
        after.push(...segments.slice(i + 1).map(cloneComposerSegment))
        return { before: coalesceComposerSegments(before), after: coalesceComposerSegments(after) }
    }
    return { before: coalesceComposerSegments(before), after: coalesceComposerSegments(after) }
}

/**
 * Replace the active `@…` word (mirror space) with a session atom + trailing space.
 */
export function insertSessionMentionInComposerSegments(
    segments: readonly ComposerSegment[],
    selection: ComposerSelection,
    mention: { id: string; title: string },
    prefixes: string[] = ['@', '/', '$']
): { segments: ComposerSegment[]; selection: ComposerSelection } {
    const mirror = mirrorComposerSegments(segments)
    const active = findActiveWord(mirror, selection, prefixes)
    const replaceStart = active?.offset ?? selection.start
    const replaceEnd = active?.endOffset ?? selection.end

    const { before } = splitMirrorAt(segments, replaceStart)
    const { after } = splitMirrorAt(segments, replaceEnd)
    const title = sanitizeMentionTitle(mention.title) || mention.id.slice(0, 8)
    const afterMirror = mirrorComposerSegments(after)
    const needsTrailingSpace = afterMirror.length === 0 || afterMirror[0] !== ' '
    const inserted: ComposerSegment[] = [
        ...before,
        { type: 'session', id: mention.id, title },
        ...(needsTrailingSpace ? [{ type: 'text' as const, text: ' ' }] : []),
    ]
    const next = coalesceComposerSegments([...inserted, ...after])
    const caret = mirrorComposerSegments(coalesceComposerSegments(inserted)).length

    return {
        segments: next,
        selection: { start: caret, end: caret },
    }
}

/** Backspace in mirror space: deletes a whole session atom when caret is just after it. */
export function deleteBackwardInComposerSegments(
    segments: readonly ComposerSegment[],
    selection: ComposerSelection
): { segments: ComposerSegment[]; selection: ComposerSelection } {
    if (selection.start !== selection.end) {
        const { before } = splitMirrorAt(segments, selection.start)
        const { after } = splitMirrorAt(segments, selection.end)
        const next = coalesceComposerSegments([...before, ...after])
        const caret = mirrorComposerSegments(before).length
        return { segments: next, selection: { start: caret, end: caret } }
    }

    if (selection.start <= 0) {
        return { segments: coalesceComposerSegments(segments), selection }
    }

    const deleteFrom = selection.start - 1
    const { before } = splitMirrorAt(segments, deleteFrom)
    const { after } = splitMirrorAt(segments, selection.start)
    const next = coalesceComposerSegments([...before, ...after])
    const caret = mirrorComposerSegments(before).length
    return { segments: next, selection: { start: caret, end: caret } }
}

/**
 * Replace a mirror-space range with plain text (slash / skill / file @ picks).
 * `addSpace` defaults true for autocomplete acceptance; paste/drop must pass false.
 */
export function insertPlainTextInComposerSegments(
    segments: readonly ComposerSegment[],
    selection: ComposerSelection,
    text: string,
    prefixes: string[] = ['@', '/', '$'],
    addSpace: boolean = true
): { segments: ComposerSegment[]; selection: ComposerSelection } {
    const mirror = mirrorComposerSegments(segments)
    const active = findActiveWord(mirror, selection, prefixes)
    const replaceStart = active?.offset ?? selection.start
    const replaceEnd = active?.endOffset ?? selection.end
    const { before } = splitMirrorAt(segments, replaceStart)
    const { after } = splitMirrorAt(segments, replaceEnd)
    const afterMirror = mirrorComposerSegments(after)
    const needsTrailingSpace =
        addSpace && (afterMirror.length === 0 || afterMirror[0] !== ' ')
    const insert = needsTrailingSpace ? `${text} ` : text
    const inserted: ComposerSegment[] = [...before, { type: 'text', text: insert }]
    const next = coalesceComposerSegments([...inserted, ...after])
    const caret = mirrorComposerSegments(coalesceComposerSegments(inserted)).length
    return {
        segments: next,
        selection: { start: caret, end: caret },
    }
}

/**
 * Serialize a mirror-space selection to wire text (session atoms keep full ids).
 * Returns null when the selection is empty (browser default copy is fine).
 */
export function serializeComposerSelection(
    segments: readonly ComposerSegment[],
    selection: ComposerSelection,
): string | null {
    if (selection.start === selection.end) return null
    const start = Math.max(0, Math.min(selection.start, selection.end))
    const end = Math.max(selection.start, selection.end)
    const { after } = splitMirrorAt(segments, start)
    const { before: selected } = splitMirrorAt(after, end - start)
    return serializeComposerSegments(selected)
}

/**
 * Insert parsed segments at the current selection (paste of wire markdown /
 * plain text). Does not treat an active `@…` word as the replace range —
 * paste always targets the caret/selection only.
 */
export function insertSegmentsInComposerSegments(
    segments: readonly ComposerSegment[],
    selection: ComposerSelection,
    inserted: readonly ComposerSegment[],
): { segments: ComposerSegment[]; selection: ComposerSelection } {
    const { before } = splitMirrorAt(segments, selection.start)
    const { after } = splitMirrorAt(segments, selection.end)
    const mid = coalesceComposerSegments(inserted)
    const head = coalesceComposerSegments([...before, ...mid])
    const next = coalesceComposerSegments([...head, ...after])
    const caret = mirrorComposerSegments(head).length
    return {
        segments: next,
        selection: { start: caret, end: caret },
    }
}

/**
 * Rich segmented composer is the product default (same as v1 @ autocomplete:
 * no user opt-in). Emergency kill-switch only:
 *   localStorage `hapi.composer.richMentions=0` or `?richMentions=0`
 *   or build `VITE_RICH_COMPOSER_MENTIONS=false`
 */
export function isRichComposerMentionsEnabled(): boolean {
    if (typeof window === 'undefined') return true
    try {
        if (window.localStorage.getItem('hapi.composer.richMentions') === '0') return false
        if (new URLSearchParams(window.location.search).get('richMentions') === '0') return false
    } catch {
        // ignore storage / URL access failures
    }
    if (import.meta.env.VITE_RICH_COMPOSER_MENTIONS === 'false') return false
    return true
}
