import { describe, expect, it, vi } from 'vitest';
import type { Metadata } from '../api/types';
import { createAcpSessionTitleSync, registerAcpSessionTitleSync } from './acpSessionTitle';
import type { AcpSessionInfoUpdate } from './backends/acp/AcpSdkBackend';

type TitleClient = Parameters<typeof createAcpSessionTitleSync>[0];

function makeClient(metadata: Partial<Metadata> = {}) {
    const state = { ...metadata } as Metadata;
    const sendClaudeSessionMessage = vi.fn();
    return {
        client: {
            getMetadata: () => ({ ...state }),
            updateMetadata: (handler: (metadata: Metadata) => Metadata) => {
                Object.assign(state, handler(state));
            },
            sendClaudeSessionMessage
        } satisfies TitleClient,
        sendClaudeSessionMessage,
        state
    };
}

describe('registerAcpSessionTitleSync', () => {
    it('forwards normalized unique ACP titles as HAPI summaries', () => {
        let listener: ((update: AcpSessionInfoUpdate) => void) | null = null;
        const backend = {
            setSessionInfoUpdateListener(next: ((update: AcpSessionInfoUpdate) => void) | null) {
                listener = next;
            }
        };
        const { client, sendClaudeSessionMessage } = makeClient();

        registerAcpSessionTitleSync(backend, client);

        listener!({ sessionId: 'session-1', title: '  Native Cursor Title  ' });
        listener!({ sessionId: 'session-1', title: 'Native Cursor Title' });
        listener!({ sessionId: 'session-1', title: '' });
        listener!({ sessionId: 'session-1', title: null });
        listener!({ sessionId: 'session-1', title: 'Untitled' });
        listener!({ sessionId: 'session-1', title: 'New Session' });
        listener!({ sessionId: 'session-1', title: 'New session - 2026-07-12T15:30:03.251Z' });

        expect(sendClaudeSessionMessage).toHaveBeenCalledTimes(1);
        expect(sendClaudeSessionMessage).toHaveBeenCalledWith({
            type: 'summary',
            summary: 'Native Cursor Title',
            leafUuid: expect.any(String)
        });
    });

    it('stops syncing native titles after a manual title is set', () => {
        const { client, sendClaudeSessionMessage } = makeClient();
        const controller = createAcpSessionTitleSync(client);

        controller.syncNativeTitle('Native Title');
        controller.markManualTitle();
        controller.syncNativeTitle('Newer Native Title');

        expect(sendClaudeSessionMessage).toHaveBeenCalledTimes(1);
        expect(sendClaudeSessionMessage).toHaveBeenCalledWith({
            type: 'summary',
            summary: 'Native Title',
            leafUuid: expect.any(String)
        });
    });

    it('persists manual precedence in metadata and honors it after controller recreation', () => {
        const first = makeClient();
        const firstController = createAcpSessionTitleSync(first.client);
        firstController.syncNativeTitle('Native Title');
        firstController.markManualTitle();

        expect(first.state.acpManualTitle).toBe(true);

        const second = makeClient(first.state);
        const secondController = createAcpSessionTitleSync(second.client);
        secondController.syncNativeTitle('Newer Native Title');

        expect(second.sendClaudeSessionMessage).not.toHaveBeenCalled();
    });
});
