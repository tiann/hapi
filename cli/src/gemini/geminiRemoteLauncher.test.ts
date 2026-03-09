import { describe, it, expect, vi, afterEach } from 'vitest';
import { geminiRemoteLauncher } from './geminiRemoteLauncher';

vi.mock('./utils/geminiBackend');
vi.mock('./utils/config');
vi.mock('./utils/sessionScanner', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./utils/sessionScanner')>();
    return {
        ...actual,
        findGeminiTranscriptPath: vi.fn(),
        readGeminiTranscript: vi.fn(),
    };
});
vi.mock('@/codex/utils/buildHapiMcpBridge');
vi.mock('@/ui/ink/GeminiDisplay');
vi.mock('./utils/permissionHandler', () => ({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    GeminiPermissionHandler: vi.fn().mockImplementation(function(this: any) {
        this.cancelAll = vi.fn().mockResolvedValue(undefined);
    }),
}));

afterEach(() => {
    vi.clearAllMocks();
});

function makeMockSession(opts: { sessionId: string | null; historyReplayCutoff?: number } = { sessionId: null }) {
    return {
        sessionId: opts.sessionId,
        path: '/test/path',
        logPath: '/test/log',
        historyReplayed: false,
        historyReplayCutoff: opts.historyReplayCutoff ?? 0,
        queue: {
            waitForMessagesAndGetAsString: vi.fn().mockResolvedValue(null),
            size: vi.fn().mockReturnValue(0),
            reset: vi.fn(),
        },
        client: {
            rpcHandlerManager: { registerHandler: vi.fn() },
            sendSessionEvent: vi.fn(),
        },
        sendSessionEvent: vi.fn(),
        sendUserMessage: vi.fn(),
        sendCodexMessage: vi.fn(),
        onSessionFound: vi.fn(),
        onThinkingChange: vi.fn(),
        getPermissionMode: vi.fn().mockReturnValue('auto'),
    };
}

async function setupMocks() {
    const { createGeminiBackend } = await import('./utils/geminiBackend');
    const { buildHapiMcpBridge } = await import('@/codex/utils/buildHapiMcpBridge');
    const { resolveGeminiRuntimeConfig } = await import('./utils/config');

    const mockBackend = {
        onStderrError: vi.fn(),
        initialize: vi.fn().mockResolvedValue(undefined),
        loadSession: vi.fn(),
        newSession: vi.fn().mockResolvedValue('new-acp-session-id'),
        prompt: vi.fn().mockResolvedValue(undefined),
        cancelPrompt: vi.fn(),
        disconnect: vi.fn().mockResolvedValue(undefined),
        processingMessage: false,
    };

    vi.mocked(createGeminiBackend).mockReturnValue(mockBackend as never);
    vi.mocked(buildHapiMcpBridge).mockResolvedValue({ server: { stop: vi.fn() }, mcpServers: {} } as never);
    vi.mocked(resolveGeminiRuntimeConfig).mockReturnValue({ model: 'gemini-2.5-pro', token: undefined } as never);

    return mockBackend;
}

describe('geminiRemoteLauncher', () => {
    describe('history replay on resume', () => {
        it('does not replay history when loadSession fails (model has no prior context)', async () => {
            const mockBackend = await setupMocks();
            const { findGeminiTranscriptPath } = await import('./utils/sessionScanner');

            mockBackend.loadSession.mockRejectedValue(new Error('session not found'));

            const session = makeMockSession({ sessionId: 'existing-session-id' });
            await geminiRemoteLauncher(session as never, {});

            expect(findGeminiTranscriptPath).not.toHaveBeenCalled();
        });

        it('replays history when loadSession succeeds', async () => {
            const mockBackend = await setupMocks();
            const { findGeminiTranscriptPath } = await import('./utils/sessionScanner');

            mockBackend.loadSession.mockResolvedValue('existing-session-id');
            vi.mocked(findGeminiTranscriptPath).mockResolvedValue(null);

            const session = makeMockSession({ sessionId: 'existing-session-id' });
            await geminiRemoteLauncher(session as never, {});

            expect(findGeminiTranscriptPath).toHaveBeenCalledWith('existing-session-id');
        });

        it('does not replay history when there is no sessionId', async () => {
            await setupMocks();
            const { findGeminiTranscriptPath } = await import('./utils/sessionScanner');

            const session = makeMockSession({ sessionId: null });
            await geminiRemoteLauncher(session as never, {});

            expect(findGeminiTranscriptPath).not.toHaveBeenCalled();
        });

        it('replays only up to historyReplayCutoff messages when cutoff is set', async () => {
            const mockBackend = await setupMocks();
            const { findGeminiTranscriptPath, readGeminiTranscript } = await import('./utils/sessionScanner');

            mockBackend.loadSession.mockResolvedValue('existing-session-id');
            vi.mocked(findGeminiTranscriptPath).mockResolvedValue('/some/transcript.json');
            vi.mocked(readGeminiTranscript).mockResolvedValue({
                messages: [
                    { type: 'user', content: 'msg1' },
                    { type: 'gemini', content: 'reply1' },
                    { type: 'user', content: 'msg2' },
                    { type: 'gemini', content: 'reply2' },
                ]
            });

            // historyReplayCutoff = 2: only first 2 messages (msg1 + reply1) should be replayed
            const session = makeMockSession({ sessionId: 'existing-session-id', historyReplayCutoff: 2 });
            await geminiRemoteLauncher(session as never, {});

            expect(session.sendUserMessage).toHaveBeenCalledTimes(1);
            expect(session.sendUserMessage).toHaveBeenCalledWith('msg1');
            expect(session.sendCodexMessage).toHaveBeenCalledTimes(1);
            expect(session.sendCodexMessage).toHaveBeenCalledWith(expect.objectContaining({ message: 'reply1' }));
        });

        it('replays all messages when historyReplayCutoff is 0 (no local scanner priming)', async () => {
            const mockBackend = await setupMocks();
            const { findGeminiTranscriptPath, readGeminiTranscript } = await import('./utils/sessionScanner');

            mockBackend.loadSession.mockResolvedValue('existing-session-id');
            vi.mocked(findGeminiTranscriptPath).mockResolvedValue('/some/transcript.json');
            vi.mocked(readGeminiTranscript).mockResolvedValue({
                messages: [
                    { type: 'user', content: 'msg1' },
                    { type: 'gemini', content: 'reply1' },
                ]
            });

            const session = makeMockSession({ sessionId: 'existing-session-id', historyReplayCutoff: 0 });
            await geminiRemoteLauncher(session as never, {});

            expect(session.sendUserMessage).toHaveBeenCalledTimes(1);
            expect(session.sendCodexMessage).toHaveBeenCalledTimes(1);
        });

        it('replays user messages with array content when historyReplayCutoff is 0', async () => {
            const mockBackend = await setupMocks();
            const { findGeminiTranscriptPath, readGeminiTranscript } = await import('./utils/sessionScanner');

            mockBackend.loadSession.mockResolvedValue('existing-session-id');
            vi.mocked(findGeminiTranscriptPath).mockResolvedValue('/some/transcript.json');
            vi.mocked(readGeminiTranscript).mockResolvedValue({
                messages: [
                    { type: 'user', content: [{ text: 'hello ' }, { text: 'world' }] },
                ]
            });

            const session = makeMockSession({ sessionId: 'existing-session-id', historyReplayCutoff: 0 });
            await geminiRemoteLauncher(session as never, {});

            expect(session.sendUserMessage).toHaveBeenCalledWith('hello world');
        });
    });
});
