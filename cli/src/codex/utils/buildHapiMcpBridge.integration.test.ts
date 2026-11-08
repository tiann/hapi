import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import axios from 'axios'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApiSessionClient } from '@/api/apiSession'
import * as persistence from '@/persistence'
import * as peerMessages from '@/modules/pingPeer/pingPeer'
import { createAcpSessionTitleSync } from '@/agent/acpSessionTitle'
import { buildHapiMcpBridge } from './buildHapiMcpBridge'

describe('buildHapiMcpBridge title and spawn cwd integration', () => {
    afterEach(() => vi.restoreAllMocks())

    it.each([
        { source: 'effective cwd over skill and metadata', effective: true, skill: true },
        { source: 'skill cwd over metadata', effective: false, skill: true },
        { source: 'metadata cwd without skill lookup', effective: false, skill: false }
    ])('preserves manual titles and resolves relative spawn directories using $source', async ({ effective, skill }) => {
        const sandbox = await mkdtemp(join(tmpdir(), 'hapi-bridge-cwd-'))
        const effectiveCwd = join(sandbox, 'effective')
        const skillCwd = join(sandbox, 'skill')
        const metadataCwd = join(sandbox, 'metadata')
        const expectedDirectory = join(effective ? effectiveCwd : skill ? skillCwd : metadataCwd, 'child')
        await mkdir(expectedDirectory, { recursive: true })
        let metadata: Record<string, unknown> = { path: metadataCwd, flavor: 'opencode' }
        const session = {
            sessionId: 'parent-session',
            isPending: () => false,
            getMetadata: () => metadata,
            refreshMetadata: async () => true,
            updateMetadata: vi.fn((update: (value: typeof metadata) => typeof metadata) => { metadata = update(metadata) }),
            flushMetadata: vi.fn(async () => true),
            sendAgentMessage: vi.fn(),
            sendClaudeSessionMessage: vi.fn()
        } as unknown as ApiSessionClient
        const titleSync = createAcpSessionTitleSync(session)
        const onChangeTitle = vi.fn(() => titleSync.markManualTitle())
        const spawnBodies: unknown[] = []
        let remit = ''
        vi.spyOn(persistence, 'readSettings').mockResolvedValue({ machineId: 'local-machine' } as Awaited<ReturnType<typeof persistence.readSettings>>)
        vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
            if (String(url).endsWith('/api/auth')) return { status: 200, data: { token: 'isolated-jwt' } }
            if (String(url).endsWith('/api/machines/local-machine/spawn')) {
                spawnBodies.push(body)
                return { status: 200, data: { type: 'success', sessionId: 'child-session' } }
            }
            throw new Error(`Unexpected POST ${url}`)
        })
        vi.spyOn(axios, 'get').mockImplementation(async (url) => {
            if (String(url).endsWith('/api/hub-settings')) return { status: 200, data: { peerSpawnDefaults: { agent: 'claude', permissionMode: 'bypassPermissions', models: { claude: 'sonnet' } } } }
            if (String(url).endsWith('/api/sessions/child-session/messages')) return {
                status: 200,
                data: { messages: [{ id: 'remit', createdAt: 1, content: { role: 'user', content: { text: remit } } }] }
            }
            throw new Error(`Unexpected GET ${url}`)
        })
        vi.spyOn(peerMessages, 'pingPeer').mockImplementation(async (options) => {
            remit = options.message
            return { sessionId: 'child-session', name: 'Child', localId: 'remit', delivery: 'accepted', resumed: false }
        })
        const bridge = await buildHapiMcpBridge(session, {
            exportSessionEnv: false,
            onChangeTitle,
            workingDirectory: effective ? effectiveCwd : undefined,
            skillLookup: skill ? { workingDirectory: skillCwd, flavor: 'opencode' } : undefined
        })
        const mcp = new Client({ name: 'bridge-integration-test', version: '1.0.0' })
        try {
            await mcp.connect(new StreamableHTTPClientTransport(new URL(bridge.server.url)))
            const renamed = await mcp.callTool({ name: 'change_title', arguments: { title: '  Manual\n Bridge Title  ' } })
            expect(renamed.isError).toBe(false)
            expect(onChangeTitle).toHaveBeenCalledExactlyOnceWith('Manual Bridge Title')
            expect(session.flushMetadata).toHaveBeenCalledTimes(2)
            expect(metadata).toMatchObject({ name: 'Manual Bridge Title', acpManualTitle: true })
            titleSync.syncNativeTitle('Later native title')
            expect(metadata).toMatchObject({ name: 'Manual Bridge Title', acpManualTitle: true })
            expect(session.sendClaudeSessionMessage).not.toHaveBeenCalled()

            const spawned = await mcp.callTool({ name: 'spawn_peer', arguments: { directory: './child', message: 'Run the tests' } })
            expect(spawned.isError, JSON.stringify(spawned.content)).toBe(false)
            expect(spawnBodies).toEqual([expect.objectContaining({ directory: expectedDirectory })])
            expect(remit).toContain('/sessions/parent-session')
        } finally {
            await mcp.close()
            bridge.server.stop()
            await rm(sandbox, { recursive: true, force: true })
        }
    })
})
