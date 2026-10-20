import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PingPeerError } from '@/modules/pingPeer/pingPeer'

const { searchPeerSessions, formatPeerSessionsList } = vi.hoisted(() => ({
    searchPeerSessions: vi.fn(),
    formatPeerSessionsList: vi.fn((_sessions: unknown, _opts: unknown) => 'formatted'),
}))

vi.mock('@/ui/tokenInit', () => ({
    initializeToken: vi.fn(async () => undefined),
}))

vi.mock('@/modules/pingPeer/pingPeer', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/modules/pingPeer/pingPeer')>()
    return {
        ...actual,
        searchPeerSessions,
        formatPeerSessionsList,
    }
})

import { handleSearchPeersCommand, parseSearchPeersArgs } from './searchPeers'

describe('parseSearchPeersArgs', () => {
    it('parses query and limit', () => {
        expect(parseSearchPeersArgs(['hetzner', '--limit', '20'])).toEqual({
            help: false,
            query: 'hetzner',
            limit: 20
        })
    })

    it('joins multi-word query args', () => {
        expect(parseSearchPeersArgs(['Arthur', 'Scout', 'deploy'])).toEqual({
            help: false,
            query: 'Arthur Scout deploy'
        })
    })

    it('rejects bad limit', () => {
        expect(() => parseSearchPeersArgs(['q', '--limit', '0'])).toThrow(PingPeerError)
    })
})

describe('handleSearchPeersCommand overflow probe', () => {
    beforeEach(() => {
        searchPeerSessions.mockReset()
        formatPeerSessionsList.mockReset()
        formatPeerSessionsList.mockReturnValue('formatted')
        vi.spyOn(console, 'log').mockImplementation(() => undefined)
    })

    it('fetches page+1 and sets hasMore when more matches than the displayed limit', async () => {
        const rows = Array.from({ length: 31 }, (_, i) => ({
            id: `id-${i}`,
            updatedAt: 1000 - i,
            active: false,
            metadata: { name: `peer ${i}`, path: `/tmp/${i}`, host: 'h', flavor: 'codex' as const },
        }))
        searchPeerSessions.mockResolvedValue(rows)

        await handleSearchPeersCommand(['hetzner'])

        expect(searchPeerSessions).toHaveBeenCalledWith({
            query: 'hetzner',
            limit: 31, // peerListFetchLimit(30)
        })
        expect(formatPeerSessionsList).toHaveBeenCalledWith(rows, expect.objectContaining({
            maxRows: 30,
            hasMore: true,
            preserveOrder: true,
            dense: true,
        }))
    })

    it('does not claim overflow when the fetch fits the page', async () => {
        const rows = Array.from({ length: 10 }, (_, i) => ({
            id: `id-${i}`,
            updatedAt: 1000 - i,
            active: false,
            metadata: { name: `peer ${i}`, path: `/tmp/${i}`, host: 'h', flavor: 'codex' as const },
        }))
        searchPeerSessions.mockResolvedValue(rows)

        await handleSearchPeersCommand(['hetzner', '--limit', '30'])

        expect(formatPeerSessionsList).toHaveBeenCalledWith(rows, expect.objectContaining({
            maxRows: 30,
            hasMore: false,
        }))
    })
})
