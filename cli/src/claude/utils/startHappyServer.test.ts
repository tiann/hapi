import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApiSessionClient } from '@/api/apiSession'
import { upsertSessionExternalRef } from '@/api/upsertSessionExternalRef'
import { startHappyServer, toClaudeAllowedHapiMcpTools } from './startHappyServer'

vi.mock('@/api/upsertSessionExternalRef', () => ({
    upsertSessionExternalRef: vi.fn()
}))

const mockUpsertSessionExternalRef = vi.mocked(upsertSessionExternalRef)

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

    it('does not expose change_title when native ACP titles are enabled', async () => {
        const sessionClient = {
            updateMetadata: vi.fn(),
            sendAgentMessage: vi.fn(),
            sendClaudeSessionMessage: vi.fn()
        } as unknown as ApiSessionClient
        const server = await startHappyServer(sessionClient, { enableChangeTitle: false, enableLinkPr: false })
        stopServer = server.stop
        const mcp = new Client({ name: 'hapi-test', version: '1.0.0' })
        client = mcp

        await mcp.connect(new StreamableHTTPClientTransport(new URL(server.url)))
        const tools = await mcp.listTools()

        expect(server.toolNames).toEqual([
            'display_image',
            'display_video',
            'display_media',
            'list_peers',
            'ping_peer',
            'inspect_peer',
        ])
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

describe('startHappyServer link_pr', () => {
    let stopServer: (() => void) | null
    let mcp: Client | null

    afterEach(async () => {
        await mcp?.close()
        stopServer?.()
        mcp = null
        stopServer = null
        mockUpsertSessionExternalRef.mockReset()
    })

    async function connectWithClient(sessionClient: ApiSessionClient): Promise<Client> {
        const server = await startHappyServer(sessionClient, { enableChangeTitle: false, enableLinkPr: true })
        stopServer = server.stop
        mcp = new Client({ name: 'hapi-link-pr-test', version: '1.0.0' })
        await mcp.connect(new StreamableHTTPClientTransport(new URL(server.url)))
        return mcp
    }

    it('reports success when hub upsert persists the ref', async () => {
        const linkedRef = {
            kind: 'github_pr' as const,
            repo: 'tiann/hapi',
            number: 1163,
            url: 'https://github.com/tiann/hapi/pull/1163',
            role: 'primary' as const,
            source: 'agent' as const,
            linkedAt: 1_700_000_000_000
        }
        mockUpsertSessionExternalRef.mockResolvedValue({
            ok: true,
            status: 200,
            externalRefs: [linkedRef]
        })
        const sessionClient = {
            sessionId: 'sess-1',
            updateMetadata: vi.fn(),
            flushMetadata: vi.fn(async () => true),
            getMetadata: vi.fn(() => ({ externalRefs: [linkedRef] })),
            sendAgentMessage: vi.fn(),
            sendClaudeSessionMessage: vi.fn()
        } as unknown as ApiSessionClient

        const client = await connectWithClient(sessionClient)
        const result = await client.callTool({
            name: 'link_pr',
            arguments: { url: 'https://github.com/tiann/hapi/pull/1163' }
        }) as ToolResult

        expect(result.isError).toBe(false)
        expect(result.content?.[0]?.text).toContain('Linked tiann/hapi#1163')
        expect(mockUpsertSessionExternalRef).toHaveBeenCalledWith('sess-1', expect.objectContaining({
            repo: 'tiann/hapi',
            number: 1163
        }))
        expect(sessionClient.flushMetadata).not.toHaveBeenCalled()
    })

    it('upserts without wiping other github_pr refs', async () => {
        const existing = {
            kind: 'github_pr' as const,
            repo: 'tiann/hapi',
            number: 100,
            url: 'https://github.com/tiann/hapi/pull/100',
            role: 'primary' as const,
            source: 'user' as const,
            linkedAt: 1
        }
        const secondary = {
            kind: 'github_pr' as const,
            repo: 'tiann/hapi',
            number: 1163,
            url: 'https://github.com/tiann/hapi/pull/1163',
            role: 'secondary' as const,
            source: 'agent' as const,
            linkedAt: 2
        }
        mockUpsertSessionExternalRef.mockResolvedValue({
            ok: true,
            status: 200,
            externalRefs: [existing, secondary]
        })
        const sessionClient = {
            sessionId: 'sess-1',
            updateMetadata: vi.fn(),
            flushMetadata: vi.fn(async () => true),
            getMetadata: vi.fn(() => ({ externalRefs: [existing, secondary] })),
            sendAgentMessage: vi.fn(),
            sendClaudeSessionMessage: vi.fn()
        } as unknown as ApiSessionClient

        const client = await connectWithClient(sessionClient)
        const result = await client.callTool({
            name: 'link_pr',
            arguments: { url: 'https://github.com/tiann/hapi/pull/1163', role: 'secondary' }
        }) as ToolResult

        expect(result.isError).toBe(false)
        expect(mockUpsertSessionExternalRef).toHaveBeenCalledWith('sess-1', expect.objectContaining({
            repo: 'tiann/hapi',
            number: 1163,
            role: 'secondary'
        }))
        expect(sessionClient.flushMetadata).not.toHaveBeenCalled()
    })

    it('preserves cached health when re-linking the same PR', async () => {
        const existing = {
            kind: 'github_pr' as const,
            repo: 'tiann/hapi',
            number: 1163,
            url: 'https://github.com/tiann/hapi/pull/1163',
            role: 'primary' as const,
            source: 'agent' as const,
            linkedAt: 300,
            openState: 'open' as const,
            checks: 'pending' as const,
            merge: 'unstable' as const,
            statusCheckedAt: 200,
            estateCode: 'ci_pending'
        }
        mockUpsertSessionExternalRef.mockResolvedValue({
            ok: true,
            status: 200,
            externalRefs: [existing]
        })
        const sessionClient = {
            sessionId: 'sess-1',
            updateMetadata: vi.fn(),
            flushMetadata: vi.fn(async () => true),
            getMetadata: vi.fn(() => ({ externalRefs: [existing] })),
            sendAgentMessage: vi.fn(),
            sendClaudeSessionMessage: vi.fn()
        } as unknown as ApiSessionClient

        const client = await connectWithClient(sessionClient)
        const result = await client.callTool({
            name: 'link_pr',
            arguments: { url: 'https://github.com/tiann/hapi/pull/1163' }
        }) as ToolResult

        expect(result.isError).toBe(false)
        expect(mockUpsertSessionExternalRef).toHaveBeenCalledOnce()
        expect(sessionClient.flushMetadata).not.toHaveBeenCalled()
    })

    it('errors when the hub does not persist the linked ref', async () => {
        mockUpsertSessionExternalRef.mockResolvedValue({
            ok: true,
            status: 200,
            externalRefs: []
        })
        const sessionClient = {
            sessionId: 'sess-1',
            updateMetadata: vi.fn(),
            flushMetadata: vi.fn(async () => true),
            getMetadata: vi.fn(() => ({ externalRefs: [] })),
            sendAgentMessage: vi.fn(),
            sendClaudeSessionMessage: vi.fn()
        } as unknown as ApiSessionClient

        const client = await connectWithClient(sessionClient)
        const result = await client.callTool({
            name: 'link_pr',
            arguments: { url: 'https://github.com/tiann/hapi/pull/1163' }
        }) as ToolResult

        expect(result.isError).toBe(true)
        expect(result.content?.[0]?.text).toContain('Hub did not persist the PR link')
    })

    it('fails once at MAX_EXTERNAL_REFS without queueing metadata retries', async () => {
        mockUpsertSessionExternalRef.mockResolvedValue({
            ok: false,
            status: 400,
            error: 'at most 32 external refs are allowed'
        })
        const sessionClient = {
            sessionId: 'sess-1',
            updateMetadata: vi.fn(),
            flushMetadata: vi.fn(async () => true),
            getMetadata: vi.fn(() => ({ externalRefs: [] })),
            sendAgentMessage: vi.fn(),
            sendClaudeSessionMessage: vi.fn()
        } as unknown as ApiSessionClient

        const client = await connectWithClient(sessionClient)
        const result = await client.callTool({
            name: 'link_pr',
            arguments: { url: 'https://github.com/tiann/hapi/pull/1163' }
        }) as ToolResult

        expect(result.isError).toBe(true)
        expect(result.content?.[0]?.text).toContain('at most 32 external refs')
        expect(mockUpsertSessionExternalRef).toHaveBeenCalledOnce()
        expect(sessionClient.flushMetadata).not.toHaveBeenCalled()
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
