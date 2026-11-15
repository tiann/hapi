import { describe, expect, it } from 'bun:test'
import type { LocalTranscript, LocalTranscriptMessage } from '@hapi/protocol/localTranscript'
import type { StoredMessage } from '../../../store'
import { matchAnchored } from './matchAnchored'

const PREFIX = 'opencode:ses-1:'

function userContent(text: string) {
    return { role: 'user', content: { type: 'text', text }, meta: { sentFrom: 'cli' } } as const
}

function transcriptMessage(id: string, text: string, anchor?: string): LocalTranscriptMessage {
    return {
        id,
        createdAt: 1,
        content: userContent(text),
        ...(anchor !== undefined ? { anchor } : {})
    }
}

function storedMessage(localId: string, text: string): StoredMessage {
    return {
        id: `stored-${localId}`,
        sessionId: 'hapi-1',
        content: userContent(text),
        createdAt: 1,
        seq: 1,
        localId,
        invokedAt: null,
        scheduledAt: null
    }
}

function transcript(messages: LocalTranscriptMessage[], anchorOrder?: string[], cursor?: string | null): LocalTranscript {
    return {
        flavor: 'opencode',
        id: 'ses-1',
        title: 't',
        file: '/tmp/db',
        modifiedAt: 1,
        messages,
        ...(anchorOrder !== undefined ? { anchorOrder } : {}),
        ...(cursor !== undefined ? { cursor } : {})
    }
}

describe('anchored match: R1 order and content', () => {
    it('appends only the delta for an extended transcript', () => {
        const stored = [storedMessage(`${PREFIX}a`, 'one')]
        const result = matchAnchored({
            storedMessages: stored,
            transcript: transcript([transcriptMessage(`${PREFIX}a`, 'one'), transcriptMessage(`${PREFIX}b`, 'two')]),
            importPrefix: PREFIX,
            cursor: null
        })
        expect(result).toEqual({ status: 'ok', delta: [transcriptMessage(`${PREFIX}b`, 'two')] })
    })

    it('rejects a changed imported entry', () => {
        const stored = [storedMessage(`${PREFIX}a`, 'one')]
        const result = matchAnchored({
            storedMessages: stored,
            transcript: transcript([transcriptMessage(`${PREFIX}a`, 'one changed')]),
            importPrefix: PREFIX,
            cursor: null
        })
        expect(result.status).toBe('transcript_diverged')
    })

    it('rejects a reordered transcript', () => {
        const stored = [storedMessage(`${PREFIX}a`, 'one'), storedMessage(`${PREFIX}b`, 'two')]
        const result = matchAnchored({
            storedMessages: stored,
            transcript: transcript([transcriptMessage(`${PREFIX}b`, 'two'), transcriptMessage(`${PREFIX}a`, 'one')]),
            importPrefix: PREFIX,
            cursor: null
        })
        expect(result.status).toBe('transcript_diverged')
    })

    it('rejects a dropped imported entry', () => {
        const stored = [storedMessage(`${PREFIX}a`, 'one'), storedMessage(`${PREFIX}b`, 'two')]
        const result = matchAnchored({
            storedMessages: stored,
            transcript: transcript([transcriptMessage(`${PREFIX}a`, 'one')]),
            importPrefix: PREFIX,
            cursor: null
        })
        expect(result.status).toBe('transcript_diverged')
    })
})

describe('anchored match: R2-R4 with a cursor', () => {
    const anchorOrder = ['a', 'b', 'c', 'd']

    function cursorTranscript(messages: LocalTranscriptMessage[], cursor: string | null): LocalTranscript {
        return {
            flavor: 'pi',
            id: 'ses-1',
            title: 't',
            file: '/tmp/pi.jsonl',
            modifiedAt: 1,
            messages,
            anchorOrder,
            cursor
        }
    }

    it('fails when the stored cursor left the active branch (R2)', () => {
        const result = matchAnchored({
            storedMessages: [storedMessage('pi:ses-1:a:user', 'one')],
            transcript: cursorTranscript([transcriptMessage('pi:ses-1:a:user', 'one', 'a')], 'z'),
            importPrefix: 'pi:ses-1:',
            cursor: 'z'
        })
        expect(result.status).toBe('transcript_diverged')
    })

    it('appends entries after the cursor (R3) and tolerates gaps before the anchor (R4)', () => {
        const result = matchAnchored({
            storedMessages: [storedMessage('pi:ses-1:a:user', 'one')],
            transcript: cursorTranscript([
                transcriptMessage('pi:ses-1:a:user', 'one', 'a'),
                transcriptMessage('pi:ses-1:c:user', 'three', 'c')
            ], 'b'),
            importPrefix: 'pi:ses-1:',
            cursor: 'b'
        })
        expect(result).toMatchObject({ status: 'ok' })
        if (result.status === 'ok') {
            expect(result.delta.map((message) => message.anchor)).toEqual(['c'])
        }
    })

    it('uses the later of the last import and the cursor as the anchor (R3)', () => {
        const result = matchAnchored({
            storedMessages: [
                storedMessage('pi:ses-1:a:user', 'one'),
                storedMessage('pi:ses-1:c:user', 'three')
            ],
            transcript: cursorTranscript([
                transcriptMessage('pi:ses-1:a:user', 'one', 'a'),
                transcriptMessage('pi:ses-1:c:user', 'three', 'c')
            ], 'b'),
            importPrefix: 'pi:ses-1:',
            cursor: 'b'
        })
        expect(result).toMatchObject({ status: 'ok', delta: [] })
    })
})

describe('anchored match: R4/R5 without a cursor', () => {
    it('rejects entries inserted ahead of the imported boundary', () => {
        const stored = [storedMessage(`${PREFIX}b`, 'two')]
        const result = matchAnchored({
            storedMessages: stored,
            transcript: transcript([transcriptMessage(`${PREFIX}a`, 'one'), transcriptMessage(`${PREFIX}b`, 'two')]),
            importPrefix: PREFIX,
            cursor: null
        })
        expect(result.status).toBe('transcript_diverged')
    })

    it('reports already_in_hapi for a HAPI-created session with a delta (R5)', () => {
        const stored = [storedMessage('local-1', 'hello from hapi')]
        const result = matchAnchored({
            storedMessages: stored,
            transcript: transcript([transcriptMessage(`${PREFIX}a`, 'one')]),
            importPrefix: PREFIX,
            cursor: null
        })
        expect(result.status).toBe('already_in_hapi')
    })

    it('keeps a fully imported transcript unchanged', () => {
        const stored = [storedMessage(`${PREFIX}a`, 'one')]
        const result = matchAnchored({
            storedMessages: stored,
            transcript: transcript([transcriptMessage(`${PREFIX}a`, 'one')]),
            importPrefix: PREFIX,
            cursor: null
        })
        expect(result).toEqual({ status: 'ok', delta: [] })
    })

    it('ignores HAPI-side extras when the transcript has no delta', () => {
        const stored = [storedMessage(`${PREFIX}a`, 'one'), storedMessage('local-1', 'hapi turn')]
        const result = matchAnchored({
            storedMessages: stored,
            transcript: transcript([transcriptMessage(`${PREFIX}a`, 'one')]),
            importPrefix: PREFIX,
            cursor: null
        })
        expect(result).toEqual({ status: 'ok', delta: [] })
    })
})