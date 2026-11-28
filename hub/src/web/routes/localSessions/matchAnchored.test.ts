import { describe, expect, it } from 'bun:test'
import type { LocalTranscript, LocalTranscriptMessage } from '@hapi/protocol/localTranscript'
import type { StoredMessage } from '../../../store'
import { matchAnchored } from './matchAnchored'
import { AGY_LOCAL_SESSION_SOURCE } from './sources'

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
        invokedAt: localId.startsWith(PREFIX) ? null : 1,
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

describe('anchored match: live Antigravity delivered-turn boundaries', () => {
    const AGY_PREFIX = 'agy:ses-1:'
    const agyMatch = AGY_LOCAL_SESSION_SOURCE.match.strategy === 'anchored'
        ? AGY_LOCAL_SESSION_SOURCE.match
        : null

    function agyStoredUser(
        seq: number,
        localId: string | null,
        text: string,
        opts: {
            invokedAt: number | null
            createdAt?: number
            attachments?: Array<{ path: string; mimeType?: string }>
        }
    ): StoredMessage {
        return {
            id: `stored-${seq}`,
            sessionId: 'hapi-agy',
            content: {
                role: 'user',
                content: {
                    type: 'text',
                    text,
                    ...(opts.attachments ? { attachments: opts.attachments } : {})
                },
                meta: { sentFrom: localId?.startsWith(AGY_PREFIX) ? 'cli' : 'web' }
            },
            createdAt: opts.createdAt ?? seq,
            seq,
            localId,
            invokedAt: opts.invokedAt,
            scheduledAt: null
        }
    }

    function agyStoredAgent(seq: number, text: string, createdAt: number, localId: string | null = null): StoredMessage {
        return {
            id: `stored-${seq}`,
            sessionId: 'hapi-agy',
            content: {
                role: 'agent',
                content: { type: 'codex', data: { type: 'message', message: text } },
                meta: { sentFrom: 'cli' }
            },
            createdAt,
            seq,
            localId,
            invokedAt: createdAt,
            scheduledAt: null
        }
    }

    function agyNativeUser(id: string, text: string): LocalTranscriptMessage {
        return {
            id: `${AGY_PREFIX}${id}`,
            createdAt: 1,
            content: { role: 'user', content: { type: 'text', text }, meta: { sentFrom: 'cli' } },
            anchor: id
        }
    }

    function agyNativeAgent(id: string, message: string): LocalTranscriptMessage {
        return {
            id: `${AGY_PREFIX}${id}`,
            createdAt: 1,
            content: { role: 'agent', content: { type: 'codex', data: { type: 'message', message } }, meta: { sentFrom: 'cli' } },
            anchor: id
        }
    }

    function agyTranscript(messages: LocalTranscriptMessage[]): LocalTranscript {
        return { flavor: 'agy', id: 'ses-1', title: 't', file: '/tmp/transcript.jsonl', modifiedAt: 1, messages }
    }

    it('aligns queued messages inserted mid-reply using delivered invokedAt order', () => {
        const stored: StoredMessage[] = [
            agyStoredUser(1, `${AGY_PREFIX}p0`, 'imported question', { invokedAt: 10, createdAt: 10 }),
            agyStoredAgent(2, 'imported answer', 11, `${AGY_PREFIX}p1`),
            agyStoredUser(3, 'live-1', 'first live prompt', { invokedAt: 20, createdAt: 20 }),
            // Queued mid-reply: seq=4 precedes seq=5, but invokedAt=30 follows seq=5 (createdAt=25).
            agyStoredUser(4, 'live-2', 'queued mid reply', { invokedAt: 30, createdAt: 22 }),
            agyStoredAgent(5, 'reply to first', 25),
            agyStoredAgent(6, 'reply to second', 35),
        ]

        const sourceMessages = [
            agyNativeUser('p0', 'imported question'),
            agyNativeAgent('p1', 'imported answer'),
            agyNativeUser('n1', 'first live prompt'),
            agyNativeAgent('n2', 'reply to first'),
            agyNativeUser('n3', 'queued mid reply'),
            agyNativeAgent('n4', 'reply to second'),
            agyNativeUser('n5', 'new native prompt'),
        ]

        const result = matchAnchored({
            storedMessages: stored,
            transcript: agyTranscript(sourceMessages),
            importPrefix: AGY_PREFIX,
            cursor: null,
            liveCompareKey: agyMatch!.liveCompareKey,
            liveUserBatchMatches: agyMatch!.liveUserBatchMatches
        })
        expect(result).toEqual({
            status: 'ok',
            delta: [agyNativeUser('n5', 'new native prompt')]
        })
    })

    it('matches same-invokedAt batched prompts with inline-stripped or @path-retained image forms', () => {
        const stored: StoredMessage[] = [
            agyStoredUser(1, `${AGY_PREFIX}p0`, 'imported', { invokedAt: 10, createdAt: 10 }),
            agyStoredUser(2, 'b1', 'check files', {
                invokedAt: 50,
                createdAt: 40,
                attachments: [
                    { path: '.hapi/uploads/doc.md', mimeType: 'text/markdown' },
                    { path: '.hapi/uploads/img.png', mimeType: 'image/png' }
                ]
            }),
            agyStoredUser(3, 'b2', 'follow up', { invokedAt: 50, createdAt: 45 }),
            agyStoredAgent(4, 'done batch', 55),
        ]

        // Inline image stripped by buildAgyPromptContent; non-image @path retained.
        const inlineStripped = matchAnchored({
            storedMessages: stored,
            transcript: agyTranscript([
                agyNativeUser('p0', 'imported'),
                agyNativeUser('b', '@.hapi/uploads/doc.md\n\ncheck files\nfollow up'),
                agyNativeAgent('a', 'done batch'),
                agyNativeUser('tail', 'afterwards')
            ]),
            importPrefix: AGY_PREFIX,
            cursor: null,
            liveCompareKey: agyMatch!.liveCompareKey,
            liveUserBatchMatches: agyMatch!.liveUserBatchMatches
        })
        expect(inlineStripped).toEqual({ status: 'ok', delta: [agyNativeUser('tail', 'afterwards')] })

        // Image @path retained (fallback when image block encoding unavailable).
        const pathRetained = matchAnchored({
            storedMessages: stored,
            transcript: agyTranscript([
                agyNativeUser('p0', 'imported'),
                agyNativeUser('b', '@.hapi/uploads/doc.md @.hapi/uploads/img.png\n\ncheck files\nfollow up'),
                agyNativeAgent('a', 'done batch'),
            ]),
            importPrefix: AGY_PREFIX,
            cursor: null,
            liveCompareKey: agyMatch!.liveCompareKey,
            liveUserBatchMatches: agyMatch!.liveUserBatchMatches
        })
        expect(pathRetained).toEqual({ status: 'ok', delta: [] })

        // Different invokedAt timestamps must NOT be merged into one native batch.
        const separateInvokedAt = [
            agyStoredUser(1, `${AGY_PREFIX}p0`, 'imported', { invokedAt: 10, createdAt: 10 }),
            agyStoredUser(2, 'b1', 'check files', { invokedAt: 50, createdAt: 40 }),
            agyStoredUser(3, 'b2', 'follow up', { invokedAt: 51, createdAt: 45 }),
        ]
        expect(matchAnchored({
            storedMessages: separateInvokedAt,
            transcript: agyTranscript([
                agyNativeUser('p0', 'imported'),
                agyNativeUser('b', 'check files\nfollow up')
            ]),
            importPrefix: AGY_PREFIX,
            cursor: null,
            liveCompareKey: agyMatch!.liveCompareKey,
            liveUserBatchMatches: agyMatch!.liveUserBatchMatches
        }).status).toBe('transcript_diverged')
    })

    it('validates live gaps strictly between earlier and later imported pins and rejects missing @path or reordered replies', () => {
        const stored: StoredMessage[] = [
            agyStoredUser(1, `${AGY_PREFIX}p0`, 'start', { invokedAt: 10, createdAt: 10 }),
            agyStoredUser(2, 'l1', 'mid live', { invokedAt: 20, createdAt: 20 }),
            agyStoredAgent(3, 'mid reply', 25),
            agyStoredUser(4, `${AGY_PREFIX}p1`, 'later imported pin', { invokedAt: 30, createdAt: 30 }),
            agyStoredUser(5, 'l2', 'after pin', { invokedAt: 40, createdAt: 40 }),
            agyStoredAgent(6, 'after reply', 45),
        ]

        const ok = matchAnchored({
            storedMessages: stored,
            transcript: agyTranscript([
                agyNativeUser('p0', 'start'),
                agyNativeUser('l1', 'mid live'),
                agyNativeAgent('a1', 'mid reply'),
                agyNativeUser('p1', 'later imported pin'),
                agyNativeUser('l2', 'after pin'),
                agyNativeAgent('a2', 'after reply'),
                agyNativeUser('tail', 'newest native')
            ]),
            importPrefix: AGY_PREFIX,
            cursor: null,
            liveCompareKey: agyMatch!.liveCompareKey,
            liveUserBatchMatches: agyMatch!.liveUserBatchMatches
        })
        expect(ok).toEqual({ status: 'ok', delta: [agyNativeUser('tail', 'newest native')] })

        // Extra native message inside a closed gap before p1 must diverge.
        const extraInClosedGap = matchAnchored({
            storedMessages: stored,
            transcript: agyTranscript([
                agyNativeUser('p0', 'start'),
                agyNativeUser('l1', 'mid live'),
                agyNativeAgent('a1', 'mid reply'),
                agyNativeAgent('extra', 'unmatched native message'),
                agyNativeUser('p1', 'later imported pin'),
                agyNativeUser('l2', 'after pin'),
                agyNativeAgent('a2', 'after reply')
            ]),
            importPrefix: AGY_PREFIX,
            cursor: null,
            liveCompareKey: agyMatch!.liveCompareKey,
            liveUserBatchMatches: agyMatch!.liveUserBatchMatches
        })
        expect(extraInClosedGap.status).toBe('transcript_diverged')

        // An agent message strictly after User2 (seq & invokedAt) must not align before User2.
        const reorderedStored: StoredMessage[] = [
            agyStoredUser(1, `${AGY_PREFIX}p0`, 'start', { invokedAt: 10, createdAt: 10 }),
            agyStoredUser(2, 'u1', 'first', { invokedAt: 20, createdAt: 20 }),
            agyStoredUser(3, 'u2', 'second', { invokedAt: 30, createdAt: 25 }),
            agyStoredAgent(4, 'reply after second', 35),
        ]
        expect(matchAnchored({
            storedMessages: reorderedStored,
            transcript: agyTranscript([
                agyNativeUser('p0', 'start'),
                agyNativeUser('u1', 'first'),
                agyNativeAgent('a', 'reply after second'),
                agyNativeUser('u2', 'second')
            ]),
            importPrefix: AGY_PREFIX,
            cursor: null,
            liveCompareKey: agyMatch!.liveCompareKey,
            liveUserBatchMatches: agyMatch!.liveUserBatchMatches
        }).status).toBe('transcript_diverged')
    })
})
