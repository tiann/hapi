import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiSessionClient } from '@/api/apiSession';
import { buildHapiMcpBridge } from '@/codex/utils/buildHapiMcpBridge';
import { AGY_SAFE_HAPI_MCP_TOOLS, getAgySystemPromptAppend } from './systemPrompt';

function makeRealSessionClient(sessionId = 'agy-session-1'): ApiSessionClient {
    return {
        sessionId,
        isPending: () => false,
        materialize: vi.fn(async () => true),
        getMetadata: () => ({}),
        refreshMetadata: vi.fn(async () => true),
        flushMetadata: vi.fn(async () => true),
        updateMetadata: vi.fn(),
        rpcHandlerManager: { registerHandler: vi.fn() }
    } as unknown as ApiSessionClient;
}

describe('getAgySystemPromptAppend & server-side AGY HAPI MCP bridge boundary', () => {
    const cleanups: Array<() => void> = [];

    afterEach(() => {
        for (const stop of cleanups.splice(0)) {
            stop();
        }
    });

    it('restricts system prompt instructions to exposed safe tools and preserves /sessions/<id> non-FS guard', () => {
        const prompt = getAgySystemPromptAppend(AGY_SAFE_HAPI_MCP_TOOLS, {});
        expect(prompt).toContain('"change_title"');
        expect(prompt).toContain('skill_lookup');
        expect(prompt).toContain('Session jobs (`hapi job run`)');
        expect(prompt).toContain('/sessions/<id> is a HAPI hub path');
        expect(prompt).toContain('Peer session MCP tools are not exposed in this Antigravity session');
        expect(prompt).not.toContain('read it with inspect_peer');
        expect(prompt).not.toContain('call "ping_peer"');
        expect(prompt).not.toContain('call "list_peers"');
        expect(prompt).not.toContain('call "spawn_peer"');
        expect(getAgySystemPromptAppend(['change_title'], {})).not.toContain('Session jobs (`hapi job run`)');
    });

    it('includes peer citation tool instructions when peer tools are explicitly enabled', () => {
        const prompt = getAgySystemPromptAppend(
            ['change_title', 'session_job', 'skill_lookup', 'list_peers', 'ping_peer', 'inspect_peer', 'spawn_peer'],
            {}
        );
        expect(prompt).toContain('read it with inspect_peer');
        expect(prompt).toContain('Session jobs (`hapi job run`)');
    });

    it('exposes only AGY_SAFE_HAPI_MCP_TOOLS on the real HTTP/stdio HAPI MCP bridge', async () => {
        const bridge = await buildHapiMcpBridge(makeRealSessionClient(), {
            workingDirectory: process.cwd(),
            skillLookup: { workingDirectory: process.cwd(), flavor: 'agy' },
            enabledTools: AGY_SAFE_HAPI_MCP_TOOLS
        });
        cleanups.push(bridge.server.stop);

        const toolsArgIdx = bridge.mcpServers.hapi.args.indexOf('--tools');
        expect(toolsArgIdx).toBeGreaterThanOrEqual(0);
        expect(bridge.mcpServers.hapi.args[toolsArgIdx + 1]).toBe('change_title,session_job,skill_lookup');
        expect(Object.keys(bridge.mcpServers.hapi.tools ?? {}).sort()).toEqual([
            'change_title',
            'session_job',
            'skill_lookup'
        ]);
    });
});
