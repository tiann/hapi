import { describe, expect, it } from 'vitest'
import type { DecryptedMessage } from '@/types/api'
import { deriveSequenceCoverage, isMessageTurnStart, trimToCompleteTurns } from './message-turns'

function message(
    id: string,
    seq: number | null,
    role: 'user' | 'agent',
): DecryptedMessage {
    return {
        id,
        seq,
        localId: null,
        createdAt: seq ?? 0,
        content: {
            role,
            content: { type: 'text', text: id },
        },
    }
}

function turn(index: number, startSeq: number): DecryptedMessage[] {
    return [
        message(`user-${index}`, startSeq, 'user'),
        message(`answer-${index}`, startSeq + 1, 'agent'),
    ]
}

function claudeUserOutput(id: string, seq: number, text: string): DecryptedMessage {
    return {
        id,
        seq,
        localId: null,
        createdAt: seq,
        content: {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'user',
                    isSidechain: false,
                    message: { content: [{ type: 'text', text }] },
                },
            },
        },
    }
}

describe('trimToCompleteTurns', () => {
    it('keeps a single 2,002-row turn intact above any raw-row capacity', () => {
        const oneHugeTurn = [
            message('stress-question', 1, 'user'),
            ...Array.from({ length: 2_000 }, (_, index) => (
                message(`tool-event-${index}`, index + 2, 'agent')
            )),
            message('stress-final-answer', 2_002, 'agent'),
        ]

        const result = trimToCompleteTurns(oneHugeTurn, 1, 'append')

        expect(result.messages).toHaveLength(2_002)
        expect(result.dropped).toEqual([])
        expect(result.messages[0]?.id).toBe('stress-question')
        expect(result.messages.at(-1)?.id).toBe('stress-final-answer')
    })

    it('drops only the oldest whole turn for append capacity', () => {
        const fortyOneTurns = Array.from({ length: 41 }, (_, index) => (
            turn(index + 1, index * 2 + 1)
        )).flat()

        const result = trimToCompleteTurns(fortyOneTurns, 40, 'append')

        expect(result.messages[0]?.id).toBe('user-2')
        expect(result.messages.at(-1)?.id).toBe('answer-41')
        expect(result.dropped.map((item) => item.id)).toEqual(['user-1', 'answer-1'])
    })

    it('drops only the newest whole turn for prepend capacity', () => {
        const fortyOneTurns = Array.from({ length: 41 }, (_, index) => (
            turn(index + 1, index * 2 + 1)
        )).flat()

        const result = trimToCompleteTurns(fortyOneTurns, 40, 'prepend')

        expect(result.messages[0]?.id).toBe('user-1')
        expect(result.messages.at(-1)?.id).toBe('answer-40')
        expect(result.dropped.map((item) => item.id)).toEqual(['user-41', 'answer-41'])
    })

    it('treats messages before the first user input as one atomic leading segment', () => {
        const messages = [
            message('startup-1', 1, 'agent'),
            message('startup-2', 2, 'agent'),
            ...turn(1, 3),
            ...turn(2, 5),
        ]

        const result = trimToCompleteTurns(messages, 2, 'prepend')

        expect(result.messages.map((item) => item.id)).toEqual([
            'startup-1',
            'startup-2',
            'user-1',
            'answer-1',
        ])
        expect(result.dropped.map((item) => item.id)).toEqual(['user-2', 'answer-2'])
    })

    it('matches Hub by rejecting whitespace-only agent user output as a turn boundary', () => {
        const whitespaceOutput = claudeUserOutput('blank-user-output', 3, '   \n\t')
        expect(isMessageTurnStart(whitespaceOutput)).toBe(false)
        expect(isMessageTurnStart(claudeUserOutput('real-user-output', 5, 'next prompt'))).toBe(true)

        const messages = [
            message('user-1', 1, 'user'),
            message('answer-1', 2, 'agent'),
            whitespaceOutput,
            message('continuation-1', 4, 'agent'),
            claudeUserOutput('real-user-output', 5, 'next prompt'),
            message('answer-2', 6, 'agent'),
        ]

        const result = trimToCompleteTurns(messages, 2, 'append')

        expect(result.messages.map((item) => item.id)).toEqual(messages.map((item) => item.id))
        expect(result.dropped).toEqual([])
    })
})

describe('deriveSequenceCoverage', () => {
    it('builds continuous ranges and exposes every numeric sequence gap', () => {
        const coverage = deriveSequenceCoverage([
            message('message-1', 1, 'user'),
            message('message-2', 2, 'agent'),
            message('optimistic', null, 'user'),
            message('message-4', 4, 'agent'),
            message('message-5', 5, 'agent'),
            message('message-8', 8, 'agent'),
        ])

        expect(coverage.ranges).toEqual([
            { startSeq: 1, endSeq: 2 },
            { startSeq: 4, endSeq: 5 },
            { startSeq: 8, endSeq: 8 },
        ])
        expect(coverage.gaps).toEqual([
            { afterSeq: 2, beforeSeq: 4 },
            { afterSeq: 5, beforeSeq: 8 },
        ])
    })
})
