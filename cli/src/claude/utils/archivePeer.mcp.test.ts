import { afterEach, describe, expect, it, vi } from 'vitest'
import axios from 'axios'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { ApiSessionClient } from '@/api/apiSession'
import { startHappyServer, toClaudeAllowedHapiMcpTools } from './startHappyServer'

vi.mock('@/api/auth', () => ({ getAuthToken: () => 'token:team' }))
vi.mock('@/configuration', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/configuration')>()
    return { ...actual, configuration: { ...actual.configuration, apiUrl: 'http://hub.test' } }
})
let mcp: Client | undefined
let stop: (() => void) | undefined
afterEach(async () => { await mcp?.close(); stop?.(); vi.restoreAllMocks() })

describe('archive_peer MCP', () => {
    it('binds self to the hosting chat and allows same-namespace targets without confirmation', async () => {
        const posts: string[] = []
        vi.spyOn(axios, 'get').mockResolvedValue({
            status: 200, data: {
                sessions: [
                    { id: 'current-1', active: true }, { id: 'review-1', active: true }
                ]
            }
        })
        vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
            posts.push(String(url))
            if (String(url).endsWith('/api/auth')) {
                expect(body).toEqual({ accessToken: 'token:team' })
                return { status: 200, data: { token: 'jwt' } }
            }
            expect(config?.headers?.Authorization).toBe('Bearer jwt')
            return { status: 200, data: { ok: true } }
        })
        const server = await startHappyServer({ sessionId: 'current-1', updateMetadata: vi.fn() } as unknown as ApiSessionClient)
        stop = server.stop
        mcp = new Client({ name: 'archive-test', version: '1' }, { capabilities: {} })
        await mcp.connect(new StreamableHTTPClientTransport(new URL(server.url)))
        const tools = await mcp.listTools()
        expect(tools.tools.some(tool => tool.name === 'archive_peer')).toBe(true)
        expect(toClaudeAllowedHapiMcpTools(server.toolNames)).toContain('mcp__hapi__archive_peer')
        const result = await mcp.callTool({ name: 'archive_peer', arguments: {} })
        expect(result.isError).toBe(false)
        expect(posts.at(-1)).toBe('http://hub.test/api/sessions/current-1/archive')
        const other = await mcp.callTool({ name: 'archive_peer', arguments: { sessionIdPrefix: 'review' } })
        expect(other.isError).toBe(false)
        expect(posts.at(-1)).toBe('http://hub.test/api/sessions/review-1/archive')
        const invalid = await mcp.callTool({ name: 'archive_peer', arguments: { sessionIdPrefix: ' ' } })
        expect(invalid.isError).toBe(true)
    })
})
