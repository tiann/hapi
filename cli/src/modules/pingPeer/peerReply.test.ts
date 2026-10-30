import { describe, expect, it } from 'vitest'
import type { AxiosInstance } from 'axios'
import { forwardPeerReply, spawnPeer } from './pingPeer'

const peer = { id: 'peer-1', active: true, metadata: { name: 'Peer' } }

type Poll = {
    thinking: boolean
    invoked: boolean
    reply?: string
    replyAfterTask?: boolean
    later?: string
    batched?: boolean
    ready?: boolean
    active?: boolean
}

function hub(options: { spawn?: unknown; polls?: Poll[]; scheduled?: string; canceled?: boolean; offPage?: boolean } = {}) {
    const posts: Array<{ url: string; body: any }> = []
    const polls = [...(options.polls ?? [])]
    let current = polls[0]
    const http = {
        post: async (url: string, body: any) => {
            posts.push({ url, body })
            if (url.endsWith('/api/auth')) return { status: 200, data: { token: 'jwt' } }
            if (url.endsWith('/spawn')) return { status: 200, data: options.spawn }
            if (url.endsWith('/queued-state')) return { status: 200, data: { queuedLocalIds: [], indeterminateLocalIds: [], invokedLocalMessages: options.offPage ? [{ localId: 'task-1', invokedAt: 10 }] : [] } }
            return { status: 200, data: { ok: true } }
        },
        get: async (url: string, config?: { params?: Record<string, number> }) => {
            if (url.endsWith('/api/sessions')) return { status: 200, data: { sessions: [peer] } }
            if (url.endsWith('/messages')) {
                // Rows in hub position order (invokedAt ?? createdAt); the task sits at 10.
                const text = (role: string, value: string) => ({ role, content: { type: 'text', text: value } })
                const c = current!
                const before: any[] = []
                const after: any[] = []
                if (c.reply) (c.invoked || c.replyAfterTask ? after : before).push({ id: 'r', content: text('agent', c.reply) })
                if (c.batched) after.unshift({ id: 'u1', localId: 'task-1b', batched: true, content: text('user', 'and this') })
                if (c.later) after.push({ id: 'u2', localId: 'task-2', invoked: true, content: text('user', 'next task') }, { id: 'r2', content: text('agent', c.later) })
                if (c.ready) after.push({ id: 'e', content: { role: 'agent', content: { type: 'event', data: { type: 'ready' } } } })
                if (options.scheduled) after.push({ id: 's', scheduledAt: 1, content: text('user', options.scheduled) })
                const task = { id: 't', localId: 'task-1', invoked: c.invoked, content: text('user', 'task') }
                const rows: any[] = [
                    ...before.map((row, i) => ({ ...row, seq: i + 1 })),
                    ...(options.canceled ? [] : [{ ...task, seq: 10 }]),
                    ...after.map((row, i) => ({ ...row, seq: 11 + i }))
                ].map(({ invoked, batched, ...row }) => ({
                    ...row,
                    createdAt: row.seq,
                    invokedAt: batched ? (c.invoked ? 10 : null) : invoked ? row.seq : row.content.role === 'user' ? null : undefined
                }))
                const { afterAt, afterSeq } = config?.params ?? {}
                if (afterSeq !== undefined && !(afterSeq >= 1 && afterAt >= 0)) return { status: 400, data: { error: 'Invalid query' } }
                if (afterSeq === undefined) return { status: 200, data: { messages: options.offPage ? rows.filter((row) => row.seq > 10) : rows } }
                // Two rows per page to exercise forward paging.
                const page = rows.filter((row) => row.createdAt > afterAt || (row.createdAt === afterAt && row.seq > afterSeq)).slice(0, 2)
                const tail = page.at(-1)
                const hasMore = tail !== undefined && tail !== rows.at(-1)
                return { status: 200, data: { messages: page, page: { hasMore, nextAfterAt: tail?.createdAt, nextAfterSeq: tail?.seq } } }
            }
            current = polls.shift() ?? current
            return { status: 200, data: { session: { ...peer, active: current?.active ?? true, thinking: current?.thinking ?? false } } }
        }
    } as unknown as AxiosInstance
    return { http, posts, auth: { apiUrl: 'http://hub.test', accessToken: 'token', http } }
}

async function forwarded(polls: Poll[], scheduled?: string, canceled?: boolean, offPage?: boolean) {
    const { posts, auth } = hub({ polls, scheduled, canceled, offPage })
    await forwardPeerReply({ ...auth, peerSessionId: 'peer-1', taskLocalId: 'task-1', callerSessionId: 'caller', sleep: async () => {} })
    return posts.filter((p) => p.url.endsWith('/sessions/caller/messages')).map((p) => p.body.text)
}

describe('spawnPeer', () => {
    it('spawns on the given machine and sends the task', async () => {
        const { posts, auth } = hub({ spawn: { type: 'success', sessionId: 'peer-1' } })
        await spawnPeer({ ...auth, machineId: 'm1', directory: '/repo', agent: 'codex', message: 'task' })
        expect(posts.find((p) => p.url.endsWith('/machines/m1/spawn'))?.body).toEqual({ directory: '/repo', agent: 'codex' })
        expect(posts.find((p) => p.url.endsWith('/sessions/peer-1/messages'))?.body).toEqual({ text: 'task', localId: expect.any(String) })
    })

    it('reports a failed spawn', async () => {
        const { auth } = hub({ spawn: { type: 'error', message: 'runner offline' } })
        await expect(spawnPeer({ ...auth, machineId: 'm1', directory: '/repo', message: 'task' }))
            .rejects.toThrow('spawn failed: runner offline')
    })

    it('refuses agents whose replies cannot be forwarded', async () => {
        const { posts, auth } = hub()
        await expect(spawnPeer({ ...auth, machineId: 'm1', directory: '/repo', agent: 'pi', message: 'task' }))
            .rejects.toThrow('pi sessions do not report turn ends')
        expect(posts).toEqual([])
    })
})

describe('forwardPeerReply', () => {
    const done = (reply?: string): Poll => ({ thinking: false, invoked: true, reply, ready: true })

    it('posts the full reply once the turn after the task ends', async () => {
        const long = `line 1\n\n${'x'.repeat(2_000)}`
        expect(await forwarded([
            { thinking: false, invoked: false, reply: 'earlier answer', ready: true },
            { thinking: true, invoked: true, reply: 'working' },
            done(long),
            done(long)
        ])).toEqual([`Reply from peer [Peer](/sessions/peer-1):\n\n${long}`])
    })

    it('does not treat idle text without a ready event as the end of the turn', async () => {
        const idle = Array.from({ length: 10 }, () => ({ thinking: false, invoked: true, reply: 'partial' }))
        expect(await forwarded([...idle, done('final'), done('final')]))
            .toEqual(['Reply from peer [Peer](/sessions/peer-1):\n\nfinal'])
    })

    it('keeps the task\'s answer apart from the reply after a later message', async () => {
        const both = { ...done('answer 1'), later: 'answer 2' }
        expect(await forwarded([both, both])).toEqual([
            'Reply from peer [Peer](/sessions/peer-1):\n\nanswer 1\n\n'
            + 'The peer then took 1 more message(s), a steer or a later task, before its turn ended. Its latest reply:\n\nanswer 2'
        ])
    })

    it('treats prompts consumed with the task as one turn', async () => {
        const both = { ...done('answer to both'), batched: true }
        expect(await forwarded([both, both])).toEqual(['Reply from peer [Peer](/sessions/peer-1):\n\nanswer to both'])
    })

    it('finds a consumed task that is already off the latest page', async () => {
        expect(await forwarded([done('done'), done('done')], undefined, false, true))
            .toEqual(['Reply from peer [Peer](/sessions/peer-1):\n\ndone'])
    })

    it('reports a turn that ended without a reply', async () => {
        expect(await forwarded([done(), done()])).toEqual(['Peer [Peer](/sessions/peer-1) stopped without replying.'])
    })

    it('finishes when the peer session stops', async () => {
        const stopped = { thinking: false, invoked: true, active: false }
        expect(await forwarded([stopped, stopped])).toEqual(['Peer [Peer](/sessions/peer-1) stopped without replying.'])
    })

    it('does not forward earlier output when the peer stops before reading the task', async () => {
        const stopped = { thinking: false, invoked: false, active: false, reply: 'answer to an earlier task', replyAfterTask: true }
        expect(await forwarded([stopped, stopped])).toEqual(['Peer [Peer](/sessions/peer-1) stopped before it read the task.'])
    })

    it('reports a canceled task instead of forwarding an unrelated answer', async () => {
        expect(await forwarded([
            { thinking: false, invoked: false, reply: 'answer to an earlier task' }
        ], undefined, true)).toEqual(['The task sent to peer [Peer](/sessions/peer-1) was canceled before it ran.'])
    })

    it('ignores a pending scheduled message after the reply', async () => {
        expect(await forwarded([done('done'), done('done')], 'later'))
            .toEqual(['Reply from peer [Peer](/sessions/peer-1):\n\ndone'])
    })
})
