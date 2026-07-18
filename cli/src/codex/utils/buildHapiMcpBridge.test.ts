import { describe, expect, it, vi, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    startHappyServer: vi.fn(async () => ({
        url: 'http://127.0.0.1:1234/',
        stop: () => {},
        toolNames: []
    })),
    getHappyCliCommand: vi.fn((args: string[]) => ({
        command: 'hapi',
        args
    }))
}));

vi.mock('@/claude/utils/startHappyServer', () => ({
    startHappyServer: mocks.startHappyServer
}));

vi.mock('@/utils/spawnHappyCLI', () => ({
    getHappyCliCommand: mocks.getHappyCliCommand
}));

import { buildHapiMcpBridge } from './buildHapiMcpBridge';

describe('buildHapiMcpBridge', () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it('enables stdio goal tools only when goal tools are registered on the HTTP MCP server', async () => {
        const goalTools = ['get_goal', 'set_goal', 'clear_goal'].map((name) => ({
            name,
            description: name,
            title: name,
            inputSchema: {},
            handler: vi.fn()
        }));

        const result = await buildHapiMcpBridge({} as never, { extraTools: goalTools });

        expect(mocks.startHappyServer).toHaveBeenCalledWith({}, { extraTools: goalTools });
        expect(mocks.getHappyCliCommand).toHaveBeenCalledWith([
            'mcp',
            '--url',
            'http://127.0.0.1:1234/',
            '--goal-tools'
        ]);
        expect(result.mcpServers.hapi.args).toContain('--goal-tools');
    });

    it('does not advertise partial goal tool registrations as a complete stdio goal bundle', async () => {
        const partialGoalTool = {
            name: 'set_goal',
            description: 'Set goal',
            title: 'Set Goal',
            inputSchema: {},
            handler: vi.fn()
        };

        await buildHapiMcpBridge({} as never, { extraTools: [partialGoalTool] });

        expect(mocks.getHappyCliCommand).toHaveBeenCalledWith([
            'mcp',
            '--url',
            'http://127.0.0.1:1234/'
        ]);
    });

    it('does not expose goal tools on generic HAPI MCP bridges', async () => {
        await buildHapiMcpBridge({} as never);

        expect(mocks.getHappyCliCommand).toHaveBeenCalledWith([
            'mcp',
            '--url',
            'http://127.0.0.1:1234/'
        ]);
    });
});
