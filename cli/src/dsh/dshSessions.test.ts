import { describe, expect, it } from 'vitest'
import { listDshSessions } from './dshSessions'
import type { DshHistoryEntry, DshSessionSummary, DshWebClient } from './dshWebClient'

describe('DeepSeek Harness session history', () => {
    it('filters blank/subagent summaries and paginates selected history oldest-first', async () => {
        const summaries: DshSessionSummary[] = [
            { sessionId: 'main', updatedAt: 30, running: false, blank: false, cwd: '/repo' },
            { sessionId: 'blank', updatedAt: 20, running: false, blank: true, cwd: '/repo' },
            { sessionId: 'child', updatedAt: 10, running: false, blank: false, cwd: '/repo', origin: 'subagent' }
        ]
        const calls: Array<number | undefined> = []
        const entries = (seqs: number[]): DshHistoryEntry[] => seqs.map((seq) => ({
            event: {
                type: 'user/message',
                seq,
                time: 1_000 + seq,
                data: { source: { kind: 'user' }, content: [{ type: 'text', text: `m${seq}` }] }
            }
        }))
        const client = {
            baseUrl: 'http://127.0.0.1:3080',
            describe: async () => ({}),
            listSessions: async () => summaries,
            getHistory: async ({ beforeSeq }: { beforeSeq?: number }) => {
                calls.push(beforeSeq)
                return beforeSeq === undefined
                    ? { entries: entries([5, 6]), hasMore: true }
                    : { entries: entries([1, 2]), hasMore: false }
            }
        } as unknown as DshWebClient

        const listed = await listDshSessions({ cwd: '/repo', client })
        expect(listed.sessions.map((session) => session.id)).toEqual(['main'])

        const selected = await listDshSessions({ sessionIds: new Set(['main']), client })
        expect(calls).toEqual([undefined, 5])
        expect(selected.sessions[0]).toMatchObject({
            id: 'main',
            lastEventSeq: 6,
            messageCount: 4
        })
        expect('messages' in selected.sessions[0]!
            ? selected.sessions[0].messages.map((message) => message.eventSeq)
            : []).toEqual([1, 2, 5, 6])
    })
})
