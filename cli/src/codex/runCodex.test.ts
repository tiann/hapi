import { describe, expect, it, vi } from 'vitest';
const run = vi.hoisted(() => vi.fn(async (_options: unknown) => {}));
vi.mock('./shared/frontend', () => ({ runSharedCodex: run }));
import { runCodex } from './runCodex';

describe('Codex entrypoint', () => {
    it('uses the shared runtime for terminal, runner and resume (no exclusive-mode branch)', async () => {
        const launches = [{ startedBy: 'terminal' as const }, { startedBy: 'runner' as const },
            { existingSessionId: 'hapi', resumeSessionId: 'native', collaborationMode: 'plan' as const }];
        for (const options of launches) await runCodex(options);
        expect(run.mock.calls).toEqual(launches.map(options => [options]));
    });
});
