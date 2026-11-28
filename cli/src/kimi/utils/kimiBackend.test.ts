import { expect, it, vi } from 'vitest';
import { AcpStdioTransport } from '@/agent/backends/acp/AcpStdioTransport';
import type { AgentMessage } from '@/agent/types';
import { createKimiBackend } from './kimiBackend';

it.each([
    {
        source: 'the #2625 examples',
        chunks: ['разработан', 'ный', '\n', 'А07-42', '2', '94/2023', '\n', '\n', 'Следующий абзац'],
        expected: 'разработанный\nА07-42294/2023\n\nСледующий абзац'
    },
    {
        source: 'Kimi Code 2.8.1 with a simulated model',
        chunks: ['哈', '哈', '哈', ' ', '1', '1', '2', '2', '\n', '\n', '下一行', '\n', '尾'],
        expected: '哈哈哈 1122\n\n下一行\n尾'
    }
])('preserves repeated text and newlines in Kimi ACP deltas from $source', async ({ chunks, expected }) => {
    const sessionId = 'kimi-replay';
    let notify: Parameters<AcpStdioTransport['onNotification']>[0] = null;
    const transport = {
        onNotification: (handler: typeof notify) => { notify = handler; },
        onStderrError: vi.fn(),
        registerRequestHandler: vi.fn(),
        close: vi.fn(async () => true),
        sendRequest: vi.fn(async (method: string) => {
            switch (method) {
                case 'initialize':
                    return { protocolVersion: 1, agentCapabilities: {} };
                case 'session/new':
                    return { sessionId };
                case 'session/prompt':
                    for (const text of chunks) {
                        notify?.('session/update', {
                            sessionId,
                            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }
                        });
                    }
                    return { stopReason: 'end_turn' };
                default:
                    throw new Error(`Unexpected ACP request: ${method}`);
            }
        })
    };
    const createTransport = vi.spyOn(AcpStdioTransport, 'create')
        .mockResolvedValueOnce(transport as unknown as AcpStdioTransport);
    const backend = createKimiBackend();
    const messages: AgentMessage[] = [];
    try {
        await backend.initialize();
        const id = await backend.newSession({ cwd: process.cwd(), mcpServers: [] });
        await backend.prompt(id, [{ type: 'text', text: 'Repeat the sample with a blank line.' }], (msg) => messages.push(msg));
        const text = messages.flatMap((msg) => msg.type === 'text' && !msg.live ? [msg.text] : []).join('');
        expect(text).toBe(expected);
    } finally {
        createTransport.mockRestore();
        await backend.disconnect();
    }
});
