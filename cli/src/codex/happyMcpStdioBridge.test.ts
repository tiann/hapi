import { describe, expect, it, vi } from 'vitest'
import { registerHapiBridgeTools } from './happyMcpStdioBridge'

type RegisteredTool = {
    name: string
    config: Record<string, unknown>
    handler: (args: Record<string, unknown>) => Promise<unknown>
}

function createServerHarness() {
    const tools: RegisteredTool[] = []
    const server = {
        registerTool(name: string, config: Record<string, unknown>, handler: RegisteredTool['handler']) {
            tools.push({ name, config, handler })
        }
    }
    return { server, tools }
}

describe('registerHapiBridgeTools', () => {
    it('registers and forwards both HAPI MCP tools through the stdio bridge', async () => {
        const { server, tools } = createServerHarness()
        const callTool = vi.fn(async (request: unknown) => ({
            content: [{ type: 'text', text: 'ok' }],
            isError: false,
            request
        }))

        registerHapiBridgeTools(server, async () => ({ callTool }))

        expect(tools.map((tool) => tool.name)).toEqual(['change_title', 'send_attachment'])

        const args = {
            files: [{
                path: 'report.txt',
                filename: 'report.txt',
                mimeType: 'text/plain'
            }]
        }
        const sendAttachment = tools.find((tool) => tool.name === 'send_attachment')
        expect(sendAttachment).toBeDefined()
        await sendAttachment!.handler(args)

        expect(callTool).toHaveBeenCalledWith({
            name: 'send_attachment',
            arguments: args
        })
    })

    it('registers and forwards Codex goal tools when enabled', async () => {
        const { server, tools } = createServerHarness()
        const callTool = vi.fn(async (request: unknown) => ({
            content: [{ type: 'text', text: 'ok' }],
            isError: false,
            request
        }))

        registerHapiBridgeTools(server, async () => ({ callTool }), { includeGoalTools: true })

        expect(tools.map((tool) => tool.name)).toEqual([
            'change_title',
            'send_attachment',
            'get_goal',
            'set_goal',
            'clear_goal'
        ])

        const setGoal = tools.find((tool) => tool.name === 'set_goal')
        expect(setGoal).toBeDefined()
        await setGoal!.handler({ objective: 'new goal' })

        expect(callTool).toHaveBeenCalledWith({
            name: 'set_goal',
            arguments: { objective: 'new goal' }
        })
    })
})
