import { beforeEach, describe, expect, it, vi } from 'vitest'

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>

const harness = vi.hoisted(() => ({
    tools: new Map<string, ToolHandler>(),
    callTool: vi.fn(async (_request: unknown) => ({
        content: [{ type: 'text', text: 'forwarded' }],
        isError: false
    }))
}))

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
    McpServer: class {
        registerTool(name: string, _config: unknown, handler: ToolHandler): void {
            harness.tools.set(name, handler)
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
        harness.callTool.mockClear()
    })

    it('registers and forwards skill_lookup when the HTTP server enables it', async () => {
        await runHappyMcpStdioBridge([
            '--url',
            'http://127.0.0.1:43006',
            '--tools',
            'change_title,display_image,skill_lookup'
        ])

        expect([...harness.tools.keys()]).toEqual([
            'change_title',
            'display_image',
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
            'change_title,display_image'
        ])

        expect([...harness.tools.keys()]).toEqual(['change_title', 'display_image'])
    })
})
