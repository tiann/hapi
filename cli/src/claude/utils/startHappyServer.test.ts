import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApiSessionClient } from '@/api/apiSession'
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
            'inspect_peer',
            'list_peers'
        ])
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

        expect(server.toolNames).toEqual(['display_image', 'display_video', 'display_media', 'list_peers', 'ping_peer', 'inspect_peer'])
        expect(tools.tools.map((tool) => tool.name)).toEqual([
            'display_image',
            'display_video',
            'display_media',
            'ping_peer',
            'inspect_peer',
            'list_peers'
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
            'list_peers',
            'ping_peer',
            'inspect_peer',
            'skill_lookup'
        ])).toEqual([
            'mcp__hapi__change_title',
            'mcp__hapi__display_image',
            'mcp__hapi__list_peers',
            'mcp__hapi__skill_lookup'
        ])
        expect(toClaudeAllowedHapiMcpTools(['display_video'])).not.toContain('mcp__hapi__display_video')
        expect(toClaudeAllowedHapiMcpTools(['display_media'])).not.toContain('mcp__hapi__display_media')
    })
})
