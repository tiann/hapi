import { describe, it, expect, vi } from 'vitest';

// Stall the SDK headless probe first stage: a child without stdio pipes fails
// fast, so the probe falls through to the ACP stage.
vi.mock('node:child_process', () => ({
    spawn: vi.fn(() => ({
        stdin: null,
        stdout: null,
        kill: vi.fn(),
        once: vi.fn(),
    })),
}));

// Stall the second stage: `initialize` never resolves, which pins the whole
// listCopilotModelsForCwd probe open forever. Only the 5s race in
// buildCopilotModelsResponseFromBackend can then answer.
const initializeStall = vi.hoisted(() => vi.fn(() => new Promise<void>(() => {})));
vi.mock('@/copilot/utils/copilotBackend', () => ({
    createCopilotBackend: vi.fn(() => ({
        initialize: initializeStall,
        newSession: vi.fn(async () => 'copilot-session-1'),
        getSessionModelsMetadata: vi.fn(() => undefined),
        getConfigOptionByCategory: vi.fn(() => undefined),
        disconnect: vi.fn(async () => {}),
    })),
}));

import { buildCopilotModelsResponseFromBackend } from './copilotModels';

describe('buildCopilotModelsResponseFromBackend probe stall bound', () => {
    it('bounds a stalled live probe to 5s and falls back to the ACP snapshot', async () => {
        const backend = {
            getSessionModelsMetadata: vi.fn(() => ({
                availableModels: [{ modelId: 'gpt-5.2', name: 'GPT-5.2' }],
                currentModelId: 'gpt-5.2',
            })),
            getConfigOptionByCategory: vi.fn(() => undefined),
        };
        // Unique cwd keeps the module-level 60s probe cache cold here.
        const cwd = `/tmp/copilot-probe-stall-${process.pid}-${Date.now()}`;

        vi.useFakeTimers();
        try {
            const pending = buildCopilotModelsResponseFromBackend('copilot-session-1', backend, cwd);
            let settled = false;
            void pending.then(() => { settled = true; });
            // Just before the bound the handler must still be waiting...
            await vi.advanceTimersByTimeAsync(4_900);
            expect(settled).toBe(false);
            // ...and right after it the snapshot fallback must fire.
            await vi.advanceTimersByTimeAsync(200);
            const result = await pending;
            expect(result).toMatchObject({
                success: true,
                availableModels: [{ modelId: 'gpt-5.2', name: 'GPT-5.2' }],
                currentModelId: 'gpt-5.2',
            });
        } finally {
            vi.useRealTimers();
        }
    });
});
