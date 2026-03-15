import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createGeminiBackend } from './geminiBackend';

vi.mock('@/agent/backends/acp', () => {
    const AcpSdkBackend = vi.fn().mockImplementation(function(this: Record<string, unknown>, opts: unknown) {
        Object.assign(this, opts);
    });
    return { AcpSdkBackend };
});

vi.mock('./config', () => ({
    resolveGeminiRuntimeConfig: vi.fn().mockReturnValue({ model: 'gemini-2.5-pro', token: 'test-token' }),
    buildGeminiEnv: vi.fn().mockReturnValue({})
}));

describe('createGeminiBackend', () => {
    it('spawns gemini without --resume when no resumeSessionId', () => {
        const backend = createGeminiBackend({}) as unknown as { args: string[] };
        expect(backend.args).toEqual(['--experimental-acp', '--model', 'gemini-2.5-pro']);
        expect(backend.args).not.toContain('--resume');
    });

    it('spawns gemini with --resume when resumeSessionId is provided', () => {
        const sessionId = '8d5d37c2-dce5-460c-b516-94dbc1c197e9';
        const backend = createGeminiBackend({ resumeSessionId: sessionId }) as unknown as { args: string[] };
        expect(backend.args).toContain('--resume');
        expect(backend.args).toContain(sessionId);
        const resumeIndex = backend.args.indexOf('--resume');
        expect(backend.args[resumeIndex + 1]).toBe(sessionId);
    });

    it('does not add --resume when resumeSessionId is null', () => {
        const backend = createGeminiBackend({ resumeSessionId: null }) as unknown as { args: string[] };
        expect(backend.args).not.toContain('--resume');
    });
});
