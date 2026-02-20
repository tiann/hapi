import { describe, expect, it } from 'vitest';
import { opencodeSystemPrompt } from './systemPrompt';

describe('opencodeSystemPrompt', () => {
    it('keeps change_title instruction', () => {
        expect(opencodeSystemPrompt).toContain('hapi_change_title');
    });

    it('adds spawn_session instruction', () => {
        expect(opencodeSystemPrompt).toContain('hapi_spawn_session');
    });

    it('describes spawn heuristics and parameters', () => {
        expect(opencodeSystemPrompt).toMatch(/delegate|parallel|isolated|subtask/i);
        expect(opencodeSystemPrompt).toContain('Do not spawn');
        expect(opencodeSystemPrompt).toContain('directory');
        expect(opencodeSystemPrompt).toContain('machineId');
        expect(opencodeSystemPrompt).toContain('agent');
    });
});
