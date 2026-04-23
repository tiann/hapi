import { describe, expect, it } from 'vitest';
import { codexSystemPrompt } from './systemPrompt';

describe('codexSystemPrompt', () => {
    it('does not force Codex to call the HAPI title tool for every session', () => {
        expect(codexSystemPrompt).not.toContain('ALWAYS');
        expect(codexSystemPrompt).toContain('Only call');
        expect(codexSystemPrompt).toContain('explicitly asks');
    });
});
