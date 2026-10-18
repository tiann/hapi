import { beforeEach, describe, expect, it, vi } from 'vitest'

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>

const harness = vi.hoisted(() => ({
    tools: new Map<string, ToolHandler>(),
    configs: new Map<string, Record<string, unknown>>(),
    callTool: vi.fn(async (_request: unknown) => ({
        content: [{ type: 'text', text: 'forwarded' }],
        isError: false
    }))
}))

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
    McpServer: class {
        registerTool(name: string, config: Record<string, unknown>, handler: ToolHandler): void {
            harness.tools.set(name, handler)
            harness.configs.set(name, config)
        }

        async connect(): Promise<void> {}
    }
}))

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
    StdioServerTransport: class {}
}))

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
    Client: class {
        async connect(): Promise<void> {}

        async callTool(request: unknown): Promise<unknown> {
            return harness.callTool(request)
        }
    }
}))

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
    StreamableHTTPClientTransport: class {
        constructor(_url: URL) {}
    }
}))

import { runHappyMcpStdioBridge } from './happyMcpStdioBridge'

describe('runHappyMcpStdioBridge tool forwarding', () => {
    beforeEach(() => {
        harness.tools.clear()
        harness.configs.clear()
        harness.callTool.mockClear()
    })

    it('describes display_image as user output rather than image input', async () => {
        await runHappyMcpStdioBridge([
            '--url',
            'http://127.0.0.1:43006',
            '--tools',
            'display_image'
        ])

        const description = harness.configs.get('display_image')?.description
        expect(description).toContain('human user')
        expect(description).toContain('does not provide image input')
    })

    it('registers and forwards skill_lookup when the HTTP server enables it', async () => {
        await runHappyMcpStdioBridge([
            '--url',
            'http://127.0.0.1:43006',
            '--tools',
            'change_title,display_image,display_video,display_media,skill_lookup'
        ])

        expect([...harness.tools.keys()]).toEqual([
            'change_title',
            'display_image',
            'display_video',
            'display_media',
            'skill_lookup'
        ])

        const handler = harness.tools.get('skill_lookup')
        expect(handler).toBeDefined()
        await expect(handler?.({ name: 'review' })).resolves.toEqual({
            content: [{ type: 'text', text: 'forwarded' }],
            isError: false
        })
        expect(harness.callTool).toHaveBeenCalledWith({
            name: 'skill_lookup',
            arguments: { name: 'review' }
        })
    })

    it('keeps skill_lookup hidden when the upstream HTTP server does not enable it', async () => {
        await runHappyMcpStdioBridge([
            '--url',
            'http://127.0.0.1:43006',
            '--tools',
            'change_title,display_image,display_video'
        ])

        expect([...harness.tools.keys()]).toEqual(['change_title', 'display_image', 'display_video'])
    })

    it('forwards display_media arguments unchanged', async () => {
        await runHappyMcpStdioBridge([
            '--url',
            'http://127.0.0.1:43006',
            '--tools',
            'display_media'
        ])

        const handler = harness.tools.get('display_media')
        await expect(handler?.({ path: '/tmp/sample.wav', title: 'sample.wav' })).resolves.toEqual({
            content: [{ type: 'text', text: 'forwarded' }],
            isError: false
        })
        expect(harness.callTool).toHaveBeenCalledWith({
            name: 'display_media',
            arguments: { path: '/tmp/sample.wav', title: 'sample.wav' }
        })
    })

    it('registers ping_peer when included in --tools', async () => {
        await runHappyMcpStdioBridge([
            '--url',
            'http://127.0.0.1:43006',
            '--tools',
            'change_title,display_image,display_video,display_media,ping_peer'
        ])

        expect([...harness.tools.keys()]).toEqual([
            'change_title',
            'display_image',
            'display_video',
            'display_media',
            'ping_peer'
        ])
    })

    it('registers inspect_peer when included in --tools', async () => {
        await runHappyMcpStdioBridge([
            '--url',
            'http://127.0.0.1:43006',
            '--tools',
            'change_title,display_image,display_video,display_media,ping_peer,inspect_peer'
        ])

        expect([...harness.tools.keys()]).toEqual([
            'change_title',
            'display_image',
            'display_video',
            'display_media',
            'ping_peer',
            'inspect_peer'
        ])
    })
    it('registers spawn_peer when included in --tools', async () => {
        await runHappyMcpStdioBridge([
            '--url',
            'http://127.0.0.1:43006',
            '--tools',
            'change_title,display_image,display_video,display_media,spawn_peer'
        ])

        expect([...harness.tools.keys()]).toEqual([
            'change_title',
            'display_image',
            'display_video',
            'display_media',
            'spawn_peer'
        ])
    })

    it('accepts and forwards retry ids for peer mutations', async () => {
        await runHappyMcpStdioBridge([
            '--url',
            'http://127.0.0.1:43006',
            '--tools',
            'ping_peer,spawn_peer'
        ])

        const remitId = '7ee03698-0fe7-4f76-b8a8-d84f4eddbf5c'
        const pingArgs = {
            sessionId: '05d9f0f2-9273-4137-933c-07459a1146a2',
            message: 'status',
            remitId
        }
        const spawnArgs = { directory: '/tmp/project', message: 'work', remitId }
        const schemaFor = (name: string) => harness.configs.get(name)?.inputSchema as {
            safeParse: (value: unknown) => { success: boolean }
        }

        expect(schemaFor('ping_peer').safeParse(pingArgs).success).toBe(true)
        expect(schemaFor('spawn_peer').safeParse(spawnArgs).success).toBe(true)
        await harness.tools.get('ping_peer')?.(pingArgs)
        await harness.tools.get('spawn_peer')?.(spawnArgs)
        expect(harness.callTool).toHaveBeenCalledWith({ name: 'ping_peer', arguments: pingArgs })
        expect(harness.callTool).toHaveBeenCalledWith({ name: 'spawn_peer', arguments: spawnArgs })
    })

})
