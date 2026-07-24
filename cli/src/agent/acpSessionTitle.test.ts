import { describe, expect, it, vi } from 'vitest';
import { registerAcpSessionTitleSync } from './acpSessionTitle';
import type { AcpSessionInfoUpdate } from './backends/acp/AcpSdkBackend';

describe('registerAcpSessionTitleSync', () => {
    it('forwards normalized unique ACP titles as HAPI summaries', () => {
        let listener: ((update: AcpSessionInfoUpdate) => void) | null = null;
        const backend = {
            setSessionInfoUpdateListener(next: ((update: AcpSessionInfoUpdate) => void) | null) {
                listener = next;
            }
        };
        const sendClaudeSessionMessage = vi.fn();

        registerAcpSessionTitleSync(backend, { sendClaudeSessionMessage });

        listener!({ sessionId: 'session-1', title: '  Native Cursor Title  ' });
        listener!({ sessionId: 'session-1', title: 'Native Cursor Title' });
        listener!({ sessionId: 'session-1', title: '' });
        listener!({ sessionId: 'session-1', title: null });
        listener!({ sessionId: 'session-1', title: 'Untitled' });
        listener!({ sessionId: 'session-1', title: 'New session - 2026-07-12T15:30:03.251Z' });

        expect(sendClaudeSessionMessage).toHaveBeenCalledTimes(1);
        expect(sendClaudeSessionMessage).toHaveBeenCalledWith({
            type: 'summary',
            summary: 'Native Cursor Title',
            leafUuid: expect.any(String)
        });
    });
});
