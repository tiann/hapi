import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { pingPeerMock, spawnPeerMock } = vi.hoisted(() => ({
    pingPeerMock: vi.fn(),
    spawnPeerMock: vi.fn()
}))

vi.mock('@/modules/pingPeer/pingPeer', async () => {
    const actual = await vi.importActual<typeof import('@/modules/pingPeer/pingPeer')>(
        '@/modules/pingPeer/pingPeer'
    )
    return { ...actual, pingPeer: pingPeerMock }
})

vi.mock('@/modules/spawnPeer/spawnPeer', async () => {
    const actual = await vi.importActual<typeof import('@/modules/spawnPeer/spawnPeer')>(
        '@/modules/spawnPeer/spawnPeer'
    )
    return { ...actual, spawnPeer: spawnPeerMock }
})

import type { ApiSessionClient } from '@/api/apiSession'
import { PingPeerError } from '@/modules/pingPeer/pingPeer'
import { SpawnPeerError } from '@/modules/spawnPeer/spawnPeer'
import { startHappyServer, toClaudeAllowedHapiMcpTools } from './startHappyServer'

type ToolResult = {
    content?: Array<{ type: string; text?: string }>
    isError?: boolean
}

describe('startHappyServer skill_lookup', () => {
    const originalHome = process.env.HOME
    let sandboxDir: string
    let workingDirectory: string
    let client: Client | null
    let stopServer: (() => void) | null
    let sendAgentMessage: ReturnType<typeof vi.fn>

    beforeEach(async () => {
        pingPeerMock.mockReset()
        spawnPeerMock.mockReset()
        sandboxDir = await mkdtemp(join(tmpdir(), 'hapi-skill-mcp-'))
        workingDirectory = join(sandboxDir, 'repo')
        process.env.HOME = join(sandboxDir, 'home')
        await mkdir(join(workingDirectory, '.git'), { recursive: true })
        await mkdir(process.env.HOME, { recursive: true })
        client = null
        stopServer = null
    })

    afterEach(async () => {
        await client?.close()
        stopServer?.()
        if (originalHome === undefined) {
            delete process.env.HOME
        } else {
            process.env.HOME = originalHome
        }
        await rm(sandboxDir, { recursive: true, force: true })
    })

    async function connect(enableSkillLookup = true): Promise<Client> {
        sendAgentMessage = vi.fn()
        const sessionClient = {
            updateMetadata: vi.fn(),
            sendAgentMessage,
            sendClaudeSessionMessage: vi.fn()
        } as unknown as ApiSessionClient
        const server = await startHappyServer(sessionClient, enableSkillLookup
            ? {
                skillLookup: {
                    workingDirectory,
                    flavor: 'opencode'
                }
            }
            : {})
        stopServer = server.stop

        client = new Client(
            { name: 'hapi-skill-lookup-test', version: '1.0.0' },
            { capabilities: {} }
        )
        await client.connect(new StreamableHTTPClientTransport(new URL(server.url)))
        return client
    }

    it('returns a discovered SKILL.md body', async () => {
        const skillDir = join(workingDirectory, '.agents', 'skills', 'review')
        await mkdir(skillDir, { recursive: true })
        await writeFile(join(skillDir, 'SKILL.md'), [
            '---',
            'name: review',
            'description: Review changes safely',
            '---',
            '',
            '# Review instructions',
            '',
            'Inspect the diff before editing.'
        ].join('\n'))

        const mcp = await connect()
        const result = await mcp.callTool({
            name: 'skill_lookup',
            arguments: { name: 'review' }
        }) as ToolResult

        expect(result.isError).toBe(false)
        expect(result.content?.[0]?.text).toContain('Skill: review')
        expect(result.content?.[0]?.text).toContain('Description: Review changes safely')
        expect(result.content?.[0]?.text).toContain('# Review instructions')
    })

    it('returns a tool error for an unknown skill', async () => {
        const mcp = await connect()
        const result = await mcp.callTool({
            name: 'skill_lookup',
            arguments: { name: 'missing' }
        }) as ToolResult

        expect(result.isError).toBe(true)
        expect(result.content?.[0]?.text).toContain('Skill not found: missing')
    })

    it('does not expose the fallback tool to native-skill sessions', async () => {
        const mcp = await connect(false)
        const tools = await mcp.listTools()

        expect(tools.tools.map((tool) => tool.name)).toEqual([
            'change_title',
            'display_image',
            'display_video',
            'display_media',
            'ping_peer',
            'spawn_peer',
            'inspect_peer'
        ])
    })

    it('exposes and reuses the spawn remit after an ambiguous failure', async () => {
        const remitId = '7ee03698-0fe7-4f76-b8a8-d84f4eddbf5c'
        spawnPeerMock.mockRejectedValueOnce(new SpawnPeerError('spawn_failed', 'socket reset', remitId))
        const mcp = await connect(false)

        const result = await mcp.callTool({
            name: 'spawn_peer',
            arguments: {
                directory: '/tmp/project',
                message: 'work',
                remitId
            }
        }) as ToolResult

        expect(spawnPeerMock).toHaveBeenCalledWith(expect.objectContaining({ remitId }))
        expect(result.isError).toBe(true)
        expect(result.content?.[0]?.text).toContain(`retry spawn_peer with remitId=${remitId}`)
    })

    it('exposes and reuses the ping remit after an ambiguous failure', async () => {
        const sessionId = '05d9f0f2-9273-4137-933c-07459a1146a2'
        const remitId = '7ee03698-0fe7-4f76-b8a8-d84f4eddbf5c'
        pingPeerMock.mockRejectedValueOnce(new PingPeerError('send_failed', 'send failed: socket reset', remitId))
        const mcp = await connect(false)

        const result = await mcp.callTool({
            name: 'ping_peer',
            arguments: { sessionId, message: 'hello', remitId }
        }) as ToolResult

        expect(pingPeerMock).toHaveBeenCalledWith(expect.objectContaining({ sessionId, remitId }))
        expect(result.isError).toBe(true)
        expect(result.content?.[0]?.text).toContain(`retry ping_peer with remitId=${remitId}`)
    })

    it('does not suggest retrying a deterministic ping remit conflict', async () => {
        const sessionId = '05d9f0f2-9273-4137-933c-07459a1146a2'
        const remitId = '7ee03698-0fe7-4f76-b8a8-d84f4eddbf5c'
        pingPeerMock.mockRejectedValueOnce(new PingPeerError(
            'remit_conflict',
            'localId is already bound to a different message payload',
            remitId
        ))
        const mcp = await connect(false)

        const result = await mcp.callTool({
            name: 'ping_peer',
            arguments: { sessionId, message: 'different', remitId }
        }) as ToolResult

        expect(result.isError).toBe(true)
        expect(result.content?.[0]?.text).not.toContain('retry ping_peer')
    })

    it('describes display_image as user output rather than image input', async () => {
        const mcp = await connect(false)
        const tools = await mcp.listTools()
        const displayImage = tools.tools.find((tool) => tool.name === 'display_image')

        expect(displayImage?.description).toContain('human user')
        expect(displayImage?.description).toContain('does not provide image input')
    })

    it('displays audio through display_media and emits a generated media message', async () => {
        const path = join(sandboxDir, 'sample.wav')
        await writeFile(path, Buffer.from('RIFFxxxxWAVE'))
        const mcp = await connect(false)

        const result = await mcp.callTool({
            name: 'display_media',
            arguments: { path, title: 'sample.wav' }
        }) as ToolResult

        expect(result.isError).toBe(false)
        expect(result.content?.[0]?.text).toContain('Displayed media: sample.wav')
        expect(sendAgentMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'generated-image',
            fileName: 'sample.wav',
            mimeType: 'audio/wav',
            source: { ingress: 'mcp', toolName: 'display_media' }
        }))
    })

    it('preserves the source extension when display_media title omits one', async () => {
        const path = join(sandboxDir, 'plan-a.zip')
        await writeFile(path, Buffer.from([0x50, 0x4b, 0x03, 0x04]))
        const mcp = await connect(false)

        const result = await mcp.callTool({
            name: 'display_media',
            arguments: { path, title: 'Cursor Plan A Markdown 导出' }
        }) as ToolResult

        expect(result.isError).toBe(false)
        expect(result.content?.[0]?.text).toContain('Displayed media: Cursor Plan A Markdown 导出.zip')
        expect(sendAgentMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'generated-image',
            fileName: 'Cursor Plan A Markdown 导出.zip',
            mimeType: 'application/octet-stream',
            source: { ingress: 'mcp', toolName: 'display_media' }
        }))
    })

    it('does not expose change_title when native ACP titles are enabled', async () => {
        const sessionClient = {
            updateMetadata: vi.fn(),
            sendAgentMessage: vi.fn(),
            sendClaudeSessionMessage: vi.fn()
        } as unknown as ApiSessionClient
        const server = await startHappyServer(sessionClient, { enableChangeTitle: false })
        stopServer = server.stop
        const mcp = new Client({ name: 'hapi-test', version: '1.0.0' })
        client = mcp

        await mcp.connect(new StreamableHTTPClientTransport(new URL(server.url)))
        const tools = await mcp.listTools()

        expect(server.toolNames).toEqual(['display_image', 'display_video', 'display_media', 'ping_peer', 'inspect_peer', 'spawn_peer'])
        expect(tools.tools.map((tool) => tool.name)).toEqual([
            'display_image',
            'display_video',
            'display_media',
            'ping_peer',
            'spawn_peer',
            'inspect_peer'
        ])
    })

})

describe('toClaudeAllowedHapiMcpTools', () => {
    it('keeps local-path and peer tools registered but out of Claude --allowedTools', () => {
        expect(toClaudeAllowedHapiMcpTools([
            'change_title',
            'display_image',
            'display_video',
            'display_media',
            'ping_peer',
            'inspect_peer',
            'spawn_peer',
            'skill_lookup'
        ])).toEqual([
            'mcp__hapi__change_title',
            'mcp__hapi__display_image',
            'mcp__hapi__skill_lookup'
        ])
        expect(toClaudeAllowedHapiMcpTools(['display_video'])).not.toContain('mcp__hapi__display_video')
        expect(toClaudeAllowedHapiMcpTools(['display_media'])).not.toContain('mcp__hapi__display_media')
    })
})
