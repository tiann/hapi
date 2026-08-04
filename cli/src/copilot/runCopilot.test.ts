import { describe, expect, it, vi } from 'vitest';
import type { CopilotSession } from './session';
import { applyCopilotSlashAgentMode, resolveCopilotQueueModel } from './runCopilot';

describe('applyCopilotSlashAgentMode', () => {
    it('rejects without changing the caller mode when Copilot rejects a slash update', async () => {
        const activeSession = {
            applyRemoteAgentMode: vi.fn().mockRejectedValue(new Error('set_mode failed'))
        } as unknown as CopilotSession;
        let publishedMode: 'interactive' | 'plan' = 'interactive';

        await expect(applyCopilotSlashAgentMode(publishedMode, 'plan', activeSession))
            .rejects.toThrow('set_mode failed');

        expect(publishedMode).toBe('interactive');
        expect(activeSession.applyRemoteAgentMode).toHaveBeenCalledWith('plan');
    });
});

describe('resolveCopilotQueueModel', () => {
    it('preserves Auto as an explicit model update', () => {
        expect(resolveCopilotQueueModel('gpt-5.6')).toBe('gpt-5.6');
        expect(resolveCopilotQueueModel(null)).toBe('auto');
    });
});
