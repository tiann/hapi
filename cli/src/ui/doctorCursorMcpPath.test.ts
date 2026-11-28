import { describe, expect, it } from 'vitest'
import {
    evaluateCursorMcpPath,
    extractMcpUrlFromArgs,
    pickSessionMailbox,
    type CursorMcpPathDeps,
} from './doctorCursorMcpPath'

function deps(overrides: Partial<CursorMcpPathDeps> = {}): CursorMcpPathDeps {
    return {
        findCliPidForSession: () => 100,
        findAgentPid: () => 200,
        readCwd: () => '/work/coding/quest-audio-relay',
        readProjectMcpServers: () => ({
            hapi: { url: 'http://127.0.0.1:39617/' },
        }),
        findMcpChildUrl: () => 'http://127.0.0.1:39617/',
        isUrlListening: () => true,
        ...overrides,
    }
}

describe('doctorCursorMcpPath', () => {
    it('extractMcpUrlFromArgs reads --url', () => {
        expect(extractMcpUrlFromArgs(['mcp', '--url', 'http://127.0.0.1:1'])).toBe('http://127.0.0.1:1/')
        expect(extractMcpUrlFromArgs(['mcp'])).toBeNull()
    })

    it('pickSessionMailbox prefers bare hapi then session-scoped id', () => {
        expect(pickSessionMailbox({
            hapi: { url: 'http://127.0.0.1:1' },
            'hapi-abc': { url: 'http://127.0.0.1:2' },
        }, 'abc')).toEqual({ key: 'hapi', url: 'http://127.0.0.1:1/' })

        expect(pickSessionMailbox({
            'hapi-94f945c2-1fed-4b87-9f3f-017f4fffe22b': { url: 'http://127.0.0.1:9' },
        }, '94f945c2-1fed-4b87-9f3f-017f4fffe22b')).toEqual({
            key: 'hapi-94f945c2-1fed-4b87-9f3f-017f4fffe22b',
            url: 'http://127.0.0.1:9/',
        })
    })

    it('passes when cwd, mailbox, listen, and stdio child all align', () => {
        const result = evaluateCursorMcpPath({
            id: '94f945c2-1fed-4b87-9f3f-017f4fffe22b',
            path: '/work/coding/quest-audio-relay',
            hapiMcpUrl: 'http://127.0.0.1:39617/',
        }, deps())
        expect(result.ok).toBe(true)
        expect(result.failures).toEqual([])
        expect(result.mailboxKey).toBe('hapi')
    })

    it('fails closed on agent cwd mismatch (driver/cli latch)', () => {
        const result = evaluateCursorMcpPath({
            id: '94f945c2-1fed-4b87-9f3f-017f4fffe22b',
            path: '/work/coding/quest-audio-relay',
            hapiMcpUrl: 'http://127.0.0.1:39617/',
        }, deps({
            readCwd: () => '/work/coding/hapi/driver/cli',
        }))
        expect(result.ok).toBe(false)
        expect(result.failures.map((f) => f.code)).toContain('agent_cwd_mismatch')
    })

    it('treats /home/heavygee/coding and /work/coding path aliases as equal when resolvable', () => {
        // On oos these are the same bind mount; string inequality must not fail closed.
        const home = '/home/heavygee/coding/hapi'
        const work = '/work/coding/hapi'
        const result = evaluateCursorMcpPath({
            id: '028d0a86-262e-4538-a735-92247d17cb5f',
            path: home,
            hapiMcpUrl: 'http://127.0.0.1:46489/',
        }, deps({
            readCwd: () => work,
            readProjectMcpServers: () => ({
                'hapi-028d0a86-262e-4538-a735-92247d17cb5f': { url: 'http://127.0.0.1:46489/' },
            }),
            findMcpChildUrl: () => 'http://127.0.0.1:46489/',
        }))
        expect(result.failures.map((f) => f.code)).not.toContain('agent_cwd_mismatch')
    })

    it('fails closed when project mailbox URL is dead', () => {
        const result = evaluateCursorMcpPath({
            id: '94f945c2-1fed-4b87-9f3f-017f4fffe22b',
            path: '/work/coding/quest-audio-relay',
            hapiMcpUrl: 'http://127.0.0.1:39617/',
        }, deps({
            isUrlListening: () => false,
        }))
        expect(result.ok).toBe(false)
        expect(result.failures.map((f) => f.code)).toContain('mailbox_not_listening')
    })

    it('fails closed when only foreign hapi-<uuid> keys exist', () => {
        const result = evaluateCursorMcpPath({
            id: '94f945c2-1fed-4b87-9f3f-017f4fffe22b',
            path: '/work/coding/quest-audio-relay',
            hapiMcpUrl: 'http://127.0.0.1:39617/',
        }, deps({
            readProjectMcpServers: () => ({
                'hapi-13e763f3-aaaa-bbbb-cccc-dddddddddddd': { url: 'http://127.0.0.1:1/' },
            }),
        }))
        expect(result.ok).toBe(false)
        expect(result.failures.map((f) => f.code)).toContain('project_mcp_no_mailbox')
    })

    it('fails closed when stdio child is missing (Not connected class)', () => {
        const result = evaluateCursorMcpPath({
            id: '94f945c2-1fed-4b87-9f3f-017f4fffe22b',
            path: '/work/coding/quest-audio-relay',
            hapiMcpUrl: 'http://127.0.0.1:39617/',
        }, deps({
            findMcpChildUrl: () => null,
        }))
        expect(result.ok).toBe(false)
        expect(result.failures.map((f) => f.code)).toContain('stdio_child_missing')
    })
})
