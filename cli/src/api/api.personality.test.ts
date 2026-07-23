import { beforeEach, describe, expect, it, vi } from 'vitest'

const axiosGetMock = vi.hoisted(() => vi.fn())
const axiosPostMock = vi.hoisted(() => vi.fn())

vi.mock('axios', () => ({
    default: {
        get: axiosGetMock,
        post: axiosPostMock
    }
}))

vi.mock('@/api/auth', () => ({
    getAuthToken: () => 'cli-token'
}))

import { ApiClient } from './api'

const session = {
    id: 'session-1',
    namespace: 'default',
    seq: 1,
    createdAt: 1_710_000_000_000,
    updatedAt: 1_710_000_000_000,
    active: true,
    activeAt: 1_710_000_000_000,
    metadata: { path: '/tmp/project', host: 'test-host', flavor: 'codex' },
    metadataVersion: 0,
    agentState: null,
    agentStateVersion: 0,
    thinking: false,
    thinkingAt: 1_710_000_000_000,
    todos: [],
    model: 'gpt-5.5',
    modelReasoningEffort: null,
    effort: null,
    serviceTier: null,
    permissionMode: 'default',
    collaborationMode: 'default',
    personality: 'friendly'
}

describe('API session personality mapping', () => {
    beforeEach(() => {
        axiosGetMock.mockReset()
        axiosPostMock.mockReset()
    })

    it('maps personality from get-or-create session responses', async () => {
        axiosPostMock.mockResolvedValue({ data: { session } })
        const client = await ApiClient.create()

        const mapped = await client.getOrCreateSession({
            tag: 'test',
            metadata: session.metadata,
            state: null
        })

        expect(mapped.personality).toBe('friendly')
    })

    it('maps personality from get-session responses', async () => {
        axiosGetMock.mockResolvedValue({ data: { session: { ...session, personality: 'none' } } })
        const client = await ApiClient.create()

        const mapped = await client.getSession(session.id)

        expect(mapped.personality).toBe('none')
    })
})
