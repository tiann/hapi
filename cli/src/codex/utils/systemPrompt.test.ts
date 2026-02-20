import { describe, expect, it } from 'vitest';
import { codexSystemPrompt } from './systemPrompt';

describe('codexSystemPrompt', () => {
    it('keeps change_title instruction', () => {
        expect(codexSystemPrompt).toContain('functions.hapi__change_title');
    });

    it('adds spawn_session instruction', () => {
        expect(codexSystemPrompt).toContain('functions.hapi__spawn_session');
    });

    it('describes spawn heuristics and parameters', () => {
        expect(codexSystemPrompt).toMatch(/delegate|parallel|isolated|subtask/i);
        expect(codexSystemPrompt).toContain('Do not spawn');
        expect(codexSystemPrompt).toContain('directory');
        expect(codexSystemPrompt).toContain('machineId');
        expect(codexSystemPrompt).toContain('agent');
    });
});
