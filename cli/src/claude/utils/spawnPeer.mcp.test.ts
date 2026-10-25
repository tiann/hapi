import { afterEach, describe, expect, it, vi } from 'vitest'
import axios from 'axios'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { ApiSessionClient } from '@/api/apiSession'
import { startHappyServer } from './startHappyServer'

vi.mock('@/api/auth', () => ({ getAuthToken: () => 'token:team' }))
vi.mock('@/configuration', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/configuration')>()
    return { ...actual, configuration: { ...actual.configuration, apiUrl: 'http://hub.test' } }
})
let mcp: Client | undefined
let stop: (() => void) | undefined
afterEach(async () => { await mcp?.close(); stop?.(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

describe('spawn_peer MCP', () => {
    it.each([['claude', 'codex'], ['codex', 'claude']])('%s caller creates %s with its bound identity', async (source, target) => {
        vi.stubEnv('HAPI_SESSION_ID', 'wrong-environment-session')
        let deliveryId = ''
        vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { session: { id: 'child', active: true, metadata: { flavor: target } } } })
        const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
            if (String(url).endsWith('/api/auth')) return { status: 200, data: { token: 'jwt' } }
            expect(config?.headers?.Authorization).toBe('Bearer jwt')
            if (String(url).endsWith('/create-peer')) return { status: 200, data: { type: 'success', sessionId: 'child' } }
            if (String(url).endsWith('/messages')) { deliveryId = (body as { localId: string }).localId; return { status: 200, data: { ok: true } } }
            if (String(url).endsWith('/queued-state')) return { status: 200, data: { queuedLocalIds: [], invokedLocalMessages: [{ localId: deliveryId, invokedAt: 1 }] } }
            throw new Error('Unexpected request')
        })
        const server = await startHappyServer({ sessionId: `${source}-parent`, updateMetadata: vi.fn() } as unknown as ApiSessionClient)
        stop = server.stop
        mcp = new Client({ name: source, version: '1' })
        await mcp.connect(new StreamableHTTPClientTransport(new URL(server.url)))
        const result = await mcp.callTool({ name: 'spawn_peer', arguments: { agent: target, message: 'Review the patch', model: null, yolo: false } })
        expect(result.isError).toBe(false)
        expect(result.content).toEqual([expect.objectContaining({ text: expect.stringContaining('/sessions/child') })])
        expect(post).toHaveBeenCalledWith(`http://hub.test/api/sessions/${source}-parent/create-peer`, { agent: target, model: null, yolo: false }, expect.anything())
        const forged = await mcp.callTool({ name: 'spawn_peer', arguments: { message: 'work', parentSessionId: 'forged' } })
        expect(forged.isError).toBe(true)
    })
})
