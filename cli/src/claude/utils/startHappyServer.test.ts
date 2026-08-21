import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApiSessionClient } from '@/api/apiSession'
import { buildDisplayLinksToolName } from '@hapi/protocol'
import { startHappyServer, toClaudeAllowedHapiMcpTools } from './startHappyServer'

const TEST_SESSION_ID = 'happy-server-test-session'
const TEST_DISPLAY_LINKS_TOOL = buildDisplayLinksToolName(TEST_SESSION_ID)

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

    async function connect(enableSkillLookup = true, extra: { enableDisplayLinks?: boolean; flavor?: string } = {}): Promise<Client> {
        sendAgentMessage = vi.fn()
        const sessionClient = {
            sessionId: TEST_SESSION_ID,
            updateMetadata: vi.fn(),
            sendAgentMessage,
            sendClaudeSessionMessage: vi.fn()
        } as unknown as ApiSessionClient
        const { flavor, enableDisplayLinks } = extra
        const server = await startHappyServer(sessionClient, {
            ...(enableSkillLookup
                ? {
                    skillLookup: {
                        workingDirectory,
                        flavor: flavor ?? 'opencode'
                    }
                }
                : {}),
            ...(enableDisplayLinks !== undefined ? { enableDisplayLinks } : {}),
        })
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
        expect(tools.tools.map((tool) => tool.name)).not.toContain('display_links')
    })

    it('describes display_image as user output rather than image input', async () => {
        const mcp = await connect(false)
        const tools = await mcp.listTools()
        const displayImage = tools.tools.find((tool) => tool.name === 'display_image')

        expect(displayImage?.description).toContain('human user')
        expect(displayImage?.description).toContain('does not provide image input to the model')
        expect(displayImage?.description).toContain('cannot be used to read, inspect, or analyze image contents')
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

    it('does not expose display_links for non-cursor flavors', async () => {
        const mcp = await connect(true, { flavor: 'opencode' })
        const tools = await mcp.listTools()
        expect(tools.tools.map((tool) => tool.name)).not.toContain('display_links')
    })

    it('exposes a per-session display_links tool for cursor flavor', async () => {
        const mcp = await connect(true, { flavor: 'cursor' })
        const tools = await mcp.listTools()
        expect(tools.tools.map((tool) => tool.name)).toContain(TEST_DISPLAY_LINKS_TOOL)
        expect(tools.tools.map((tool) => tool.name)).not.toContain('display_links')
    })

    it('paints display_links via sendAgentMessage with concatenated href bytes', async () => {
        const mcp = await connect(false, { enableDisplayLinks: true })
        const href = 'https://github.com/tia' + 'nn' + '/hapi/issues/1516'

        const result = await mcp.callTool({
            name: TEST_DISPLAY_LINKS_TOOL,
            arguments: { urls: [{ href, title: 'Issue 1516' }], sessionId: TEST_SESSION_ID }
        }) as ToolResult

        expect(result.isError).toBe(false)
        expect(result.content?.[0]?.text).toContain('Displayed 1 link')
        expect(sendAgentMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'display-links',
            urls: [{ href: 'https://github.com/tiann/hapi/issues/1516', title: 'Issue 1516' }],
        }))
        const payload = sendAgentMessage.mock.calls[0]?.[0] as { urls: Array<{ href: string }> }
        expect(payload.urls[0]?.href).toBe(href)
        expect(payload.urls[0]?.href).not.toContain('tian/hapi')
    })

    it('paints display_links exact-copy texts without echoing the value in the tool result', async () => {
        const mcp = await connect(false, { enableDisplayLinks: true })
        const value = 'VK' + 'K'

        const result = await mcp.callTool({
            name: TEST_DISPLAY_LINKS_TOOL,
            arguments: { texts: [{ value, title: 'gate' }], sessionId: TEST_SESSION_ID }
        }) as ToolResult

        expect(result.isError).toBe(false)
        expect(result.content?.[0]?.text).toContain('exact-copy')
        expect(result.content?.[0]?.text).not.toContain(value)
        expect(sendAgentMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'display-links',
            texts: [{ value: 'VKK', title: 'gate' }],
        }))
        const payload = sendAgentMessage.mock.calls[0]?.[0] as { texts: Array<{ value: string }> }
        expect(payload.texts[0]?.value).toBe(value)
        expect(payload.texts[0]?.value).not.toBe('VK')
    })

    it('refuses display_links when sessionId does not match the bound MCP session', async () => {
        const mcp = await connect(false, { enableDisplayLinks: true })
        const href = 'https://example.com/kinrupt'
        const result = await mcp.callTool({
            name: TEST_DISPLAY_LINKS_TOOL,
            arguments: { urls: [{ href, title: 'Kinrupt' }], sessionId: '472632df-wrong-session' }
        }) as ToolResult

        expect(result.isError).toBe(true)
        expect(result.content?.[0]?.text).toMatch(/wrong-session/)
        expect(sendAgentMessage).not.toHaveBeenCalled()
    })

    it('refuses display_links when sessionId is omitted', async () => {
        const mcp = await connect(false, { enableDisplayLinks: true })
        const result = await mcp.callTool({
            name: TEST_DISPLAY_LINKS_TOOL,
            arguments: { urls: [{ href: 'https://example.com/x' }] }
        }) as ToolResult

        expect(result.isError).toBe(true)
        expect(result.content?.[0]?.text).toMatch(/requires sessionId/)
        expect(sendAgentMessage).not.toHaveBeenCalled()
    })

    it('rejects javascript hrefs without emitting an agent message', async () => {
        const mcp = await connect(false, { enableDisplayLinks: true })
        const result = await mcp.callTool({
            name: TEST_DISPLAY_LINKS_TOOL,
            arguments: { urls: [{ href: 'javascript:alert(1)' }], sessionId: TEST_SESSION_ID }
        }) as ToolResult

        expect(result.isError).toBe(true)
        expect(sendAgentMessage).not.toHaveBeenCalled()
    })

    it('does not expose change_title when native ACP titles are enabled', async () => {
        const sessionClient = {
            sessionId: 'happy-server-test-session',
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
