import { describe, it, expect, vi, afterEach } from 'vitest';
import { geminiLocalLauncher } from './geminiLocalLauncher';

vi.mock('./geminiLocal', () => ({ geminiLocal: vi.fn().mockResolvedValue(undefined) }));

vi.mock('./utils/sessionScanner', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./utils/sessionScanner')>();
    return {
        ...actual,
        readGeminiTranscript: vi.fn(),
        createGeminiSessionScanner: vi.fn().mockResolvedValue({
            cleanup: vi.fn().mockResolvedValue(undefined),
            onNewSession: vi.fn(),
        }),
    };
});

vi.mock('@/modules/common/launcher/BaseLocalLauncher', () => ({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    BaseLocalLauncher: vi.fn().mockImplementation(function(this: any) {
        this.run = vi.fn().mockResolvedValue('exit');
    }),
}));

afterEach(() => {
    vi.clearAllMocks();
});

function makeMockSession(opts: {
    startingMode: 'local' | 'remote';
    transcriptPath?: string;
    historyReplayed?: boolean;
}) {
    return {
        path: '/test/path',
        logPath: '/test/log',
        sessionId: null,
        transcriptPath: opts.transcriptPath ?? null,
        historyReplayed: opts.historyReplayed ?? false,
        historyReplayCutoff: 0,
        startedBy: 'runner' as const,
        startingMode: opts.startingMode,
        queue: { waitForMessagesAndGetAsString: vi.fn(), size: vi.fn(), reset: vi.fn() },
        client: { rpcHandlerManager: { registerHandler: vi.fn() } },
        sendSessionEvent: vi.fn(),
        sendUserMessage: vi.fn(),
        sendCodexMessage: vi.fn(),
        onSessionFound: vi.fn(),
        onThinkingChange: vi.fn(),
        getPermissionMode: vi.fn().mockReturnValue('auto'),
        addTranscriptPathCallback: vi.fn(),
        removeTranscriptPathCallback: vi.fn(),
        recordLocalLaunchFailure: vi.fn(),
    };
}

describe('geminiLocalLauncher', () => {
    describe('historyReplayCutoff on ensureScanner', () => {
        it('sets historyReplayed=true and historyReplayCutoff=0 when startingMode is remote (regardless of existing messages)', async () => {
            const { readGeminiTranscript } = await import('./utils/sessionScanner');
            vi.mocked(readGeminiTranscript).mockResolvedValue({
                messages: [
                    { type: 'user', content: 'msg1' },
                    { type: 'gemini', content: 'reply1' },
                ]
            });

            const session = makeMockSession({ startingMode: 'remote', transcriptPath: '/some/path.json' });
            await geminiLocalLauncher(session as never, {});

            expect(session.historyReplayed).toBe(true);
            expect(session.historyReplayCutoff).toBe(0);
        });

        it('sets historyReplayCutoff to existing count when startingMode is local and messages exist', async () => {
            const { readGeminiTranscript } = await import('./utils/sessionScanner');
            vi.mocked(readGeminiTranscript).mockResolvedValue({
                messages: [
                    { type: 'user', content: 'msg1' },
                    { type: 'gemini', content: 'reply1' },
                    { type: 'user', content: 'msg2' },
                ]
            });

            const session = makeMockSession({ startingMode: 'local', transcriptPath: '/some/path.json' });
            await geminiLocalLauncher(session as never, {});

            expect(session.historyReplayCutoff).toBe(3);
            expect(session.historyReplayed).toBe(false);
        });

        it('does not overwrite historyReplayed or historyReplayCutoff if already replayed', async () => {
            const { readGeminiTranscript } = await import('./utils/sessionScanner');
            vi.mocked(readGeminiTranscript).mockResolvedValue({
                messages: [
                    { type: 'user', content: 'msg1' },
                    { type: 'user', content: 'msg2' },
                    { type: 'user', content: 'msg3' },
                ]
            });

            const session = makeMockSession({
                startingMode: 'local',
                transcriptPath: '/some/path.json',
                historyReplayed: true,
            });
            session.historyReplayCutoff = 0;
            await geminiLocalLauncher(session as never, {});

            // historyReplayed was already true; should not be reset by scanner
            expect(session.historyReplayed).toBe(true);
            expect(session.historyReplayCutoff).toBe(0);
        });
    });
});
