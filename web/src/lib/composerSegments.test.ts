import { describe, expect, it } from 'vitest'
import { findActiveWord } from '@/utils/findActiveWord'
import {
    COMPOSER_MENTION_MIRROR_CHAR,
    deleteBackwardInComposerSegments,
    insertPlainTextInComposerSegments,
    insertSessionMentionInComposerSegments,
    mirrorComposerSegments,
    parseComposerSegments,
    serializeComposerSegments,
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
})

describe('findActiveWord with mention mirror atoms', () => {
    it('treats U+FFFC as a word boundary so @ after a mention still triggers', () => {
        const mirror = `${COMPOSER_MENTION_MIRROR_CHAR}@pee`
        const active = findActiveWord(mirror, { start: mirror.length, end: mirror.length }, ['@'])
        expect(active?.activeWord).toBe('@pee')
        expect(active?.offset).toBe(1)
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
