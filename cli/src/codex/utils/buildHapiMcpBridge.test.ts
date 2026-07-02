import { describe, expect, it, vi } from 'vitest';
import { buildHapiMcpBridge } from './buildHapiMcpBridge';

vi.mock('@/claude/utils/startHappyServer', () => ({
    startHappyServer: vi.fn(async () => ({
        url: 'http://127.0.0.1:63995/',
        stop: vi.fn(),
        toolNames: ['change_title', 'display_image', 'display_video']
    }))
}));

vi.mock('@/utils/spawnHappyCLI', () => ({
    getHappyCliCommand: vi.fn(() => ({
        command: 'hapi',
        args: ['mcp', '--url', 'http://127.0.0.1:63995/']
    }))
}));

describe('buildHapiMcpBridge', () => {
    it('auto-approves change_title, display_image, and display_video MCP tools', async () => {
        const client = {} as never;
        const bridge = await buildHapiMcpBridge(client);

        expect(bridge.mcpServers.hapi.tools).toEqual({
            change_title: { approval_mode: 'approve' },
            display_image: { approval_mode: 'approve' },
            display_video: { approval_mode: 'approve' }
        });
        expect(bridge.server.url).toBe('http://127.0.0.1:63995/');
    });
});
