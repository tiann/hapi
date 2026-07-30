import { afterEach, describe, expect, it } from 'vitest'
import { findActiveWord } from '@/utils/findActiveWord'
import {
    COMPOSER_MENTION_MIRROR_CHAR,
    deleteBackwardInComposerSegments,
    insertPlainTextInComposerSegments,
    insertSegmentsInComposerSegments,
    insertSessionMentionInComposerSegments,
    isRichComposerMentionsEnabled,
    mirrorComposerSegments,
    parseComposerSegments,
    serializeComposerSegments,
    serializeComposerSelection,
    type ComposerSegment,
} from './composerSegments'

describe('serializeComposerSegments', () => {
    it('joins text and session markdown links', () => {
        const segments: ComposerSegment[] = [
            { type: 'text', text: 'this → ' },
            { type: 'session', id: 'aaa', title: 'Peer A' },
            { type: 'text', text: ', that → ' },
            { type: 'session', id: 'bbb', title: 'Peer B' },
        ]
        expect(serializeComposerSegments(segments)).toBe(
            'this → [Peer A](/sessions/aaa), that → [Peer B](/sessions/bbb)'
        )
    })

    it('escapes brackets in titles', () => {
        const segments: ComposerSegment[] = [
            { type: 'session', id: 'x', title: 'foo [bar]' },
        ]
        expect(serializeComposerSegments(segments)).toBe('[foo \\[bar\\]](/sessions/x)')
    })

    it('puts the full session UUID in the agent prompt wire (not title alone)', () => {
        // Chip UI shows "@hub runner version governance"; send must expand to
        // markdown with the real session id so CLI/agents can resolve it.
        const sessionId = '7d55ed21-8a9f-4309-b4f8-30069df36b4b'
        const title = 'hub runner version governance'
        const wire = serializeComposerSegments([
            { type: 'text', text: 'see ' },
            { type: 'session', id: sessionId, title },
            { type: 'text', text: ' please' },
        ])
        expect(wire).toBe(
            `see [${title}](/sessions/${sessionId}) please`
        )
        expect(wire).toContain(sessionId)
        expect(wire).not.toBe(title)
        expect(wire).not.toMatch(new RegExp(`^@?${title}$`))
    })

    it('skips session atoms with empty id (never title-only wire)', () => {
        expect(serializeComposerSegments([
            { type: 'text', text: 'before ' },
            { type: 'session', id: '  ', title: 'orphan title' },
            { type: 'text', text: ' after' },
        ])).toBe('before  after')
    })
})

describe('parseComposerSegments', () => {
    it('round-trips multi-mention messages', () => {
        const source = 'this → [Peer A](/sessions/aaa), that → [Peer B](/sessions/bbb)'
        expect(serializeComposerSegments(parseComposerSegments(source))).toBe(source)
    })

    it('treats plain prose as a single text segment', () => {
        expect(parseComposerSegments('hello @world')).toEqual([
            { type: 'text', text: 'hello @world' },
        ])
    })

    it('parses BASE_URL-prefixed session paths', () => {
        expect(parseComposerSegments('[T](./app/sessions/abc)')).toEqual([
            { type: 'session', id: 'abc', title: 'T' },
        ])
    })
})

describe('insertSessionMentionInComposerSegments', () => {
    it('replaces active @query with a session atom at the caret', () => {
        const segments: ComposerSegment[] = [
            { type: 'text', text: 'see @pee for context' },
        ]
        // caret after "@pee"
        const result = insertSessionMentionInComposerSegments(
            segments,
            { start: 8, end: 8 },
            { id: 'peer-1', title: 'Peer #1' },
            ['@', '/', '$']
        )
        expect(serializeComposerSegments(result.segments)).toBe(
            'see [Peer #1](/sessions/peer-1) for context'
        )
        // caret after the mention (+ trailing space)
        expect(result.selection.start).toBeGreaterThan(4)
    })

    it('expands @ pick to markdown with full session id for the agent prompt', () => {
        const sessionId = '7d55ed21-8a9f-4309-b4f8-30069df36b4b'
        const title = 'hub runner version governance'
        const result = insertSessionMentionInComposerSegments(
            [{ type: 'text', text: 'ref @hub' }],
            { start: 8, end: 8 },
            { id: sessionId, title },
            ['@']
        )
        const wire = serializeComposerSegments(result.segments)
        expect(wire).toBe(`ref [${title}](/sessions/${sessionId}) `)
        expect(wire.includes(sessionId)).toBe(true)
        // Must not be chip-visible title alone
        expect(wire.includes(`@${title}`)).toBe(false)
    })

    it('supports mid-message second mention', () => {
        const segments = parseComposerSegments('A [Peer A](/sessions/aaa) then @b')
        const caret = mirrorComposerSegments(segments).length
        const result = insertSessionMentionInComposerSegments(
            segments,
            { start: caret, end: caret },
            { id: 'bbb', title: 'Peer B' },
            ['@']
        )
        expect(serializeComposerSegments(result.segments)).toBe(
            'A [Peer A](/sessions/aaa) then [Peer B](/sessions/bbb) '
        )
    })
})

describe('insertPlainTextInComposerSegments', () => {
    it('keeps existing session atoms when inserting a slash command', () => {
        const segments = parseComposerSegments('ref [Peer A](/sessions/aaa) /hel')
        const caret = mirrorComposerSegments(segments).length
        const result = insertPlainTextInComposerSegments(
            segments,
            { start: caret, end: caret },
            '/help',
            ['@', '/', '$']
        )
        expect(serializeComposerSegments(result.segments)).toBe(
            'ref [Peer A](/sessions/aaa) /help '
        )
    })

    it('paste/drop path does not append trailing space', () => {
        const empty = insertPlainTextInComposerSegments(
            [],
            { start: 0, end: 0 },
            'pasted',
            [],
            false
        )
        expect(serializeComposerSegments(empty.segments)).toBe('pasted')

        const mid = insertPlainTextInComposerSegments(
            [{ type: 'text', text: 'abcd' }],
            { start: 2, end: 2 },
            'X',
            [],
            false
        )
        expect(serializeComposerSegments(mid.segments)).toBe('abXcd')

        const multi = insertPlainTextInComposerSegments(
            [],
            { start: 0, end: 0 },
            'l1\nl2',
            [],
            false
        )
        expect(serializeComposerSegments(multi.segments)).toBe('l1\nl2')
    })
})

describe('findActiveWord with mention mirror atoms', () => {
    it('treats U+FFFC as a word boundary so @ after a mention still triggers', () => {
        const mirror = `${COMPOSER_MENTION_MIRROR_CHAR}@pee`
        const active = findActiveWord(mirror, { start: mirror.length, end: mirror.length }, ['@'])
        expect(active?.activeWord).toBe('@pee')
        expect(active?.offset).toBe(1)
    })
})

describe('isRichComposerMentionsEnabled', () => {
    const originalSearch = window.location.search

    afterEach(() => {
        window.localStorage.removeItem('hapi.composer.richMentions')
        window.history.replaceState({}, '', `${window.location.pathname}${originalSearch}`)
    })

    it('defaults to ON', () => {
        window.localStorage.removeItem('hapi.composer.richMentions')
        window.history.replaceState({}, '', window.location.pathname)
        expect(isRichComposerMentionsEnabled()).toBe(true)
    })

    it('kills via localStorage=0', () => {
        window.localStorage.setItem('hapi.composer.richMentions', '0')
        expect(isRichComposerMentionsEnabled()).toBe(false)
    })

    it('kills via ?richMentions=0 (not =1 force-on)', () => {
        window.history.replaceState({}, '', `${window.location.pathname}?richMentions=0`)
        expect(isRichComposerMentionsEnabled()).toBe(false)
        window.history.replaceState({}, '', `${window.location.pathname}?richMentions=1`)
        expect(isRichComposerMentionsEnabled()).toBe(true)
    })
})

describe('serializeComposerSelection', () => {
    it('emits wire markdown with session ids for a chip selection', () => {
        const segments = parseComposerSegments('see [Peer A](/sessions/aaa) please')
        // mirror: "see \uFFFC please" — select the atom only
        const start = 'see '.length
        const end = start + 1
        expect(serializeComposerSelection(segments, { start, end })).toBe(
            '[Peer A](/sessions/aaa)'
        )
    })

    it('returns null for a caret (empty selection)', () => {
        const segments: ComposerSegment[] = [{ type: 'text', text: 'abc' }]
        expect(serializeComposerSelection(segments, { start: 1, end: 1 })).toBeNull()
    })
})

describe('insertSegmentsInComposerSegments', () => {
    it('paste of wire markdown restores session atoms (not title-only text)', () => {
        const segments: ComposerSegment[] = [{ type: 'text', text: 'before ' }]
        const pasted = parseComposerSegments('[Peer A](/sessions/aaa) after')
        const result = insertSegmentsInComposerSegments(
            segments,
            { start: 'before '.length, end: 'before '.length },
            pasted,
        )
        expect(serializeComposerSegments(result.segments)).toBe(
            'before [Peer A](/sessions/aaa) after'
        )
    })
})

describe('deleteBackwardInComposerSegments', () => {
    it('deletes a whole session token when caret is immediately after it', () => {
        const segments = parseComposerSegments('hi [Peer A](/sessions/aaa) x')
        // mirror: "hi \uFFFC x" — caret after mention
        const afterMention = 'hi '.length + 1
        const result = deleteBackwardInComposerSegments(segments, {
            start: afterMention,
            end: afterMention,
        })
        expect(serializeComposerSegments(result.segments)).toBe('hi  x')
    })

    it('deletes one character in text when not against a mention', () => {
        const segments: ComposerSegment[] = [{ type: 'text', text: 'abc' }]
        const result = deleteBackwardInComposerSegments(segments, { start: 3, end: 3 })
        expect(result.segments).toEqual([{ type: 'text', text: 'ab' }])
    })
})
