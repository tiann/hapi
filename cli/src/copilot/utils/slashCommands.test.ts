import { describe, expect, it } from 'vitest';
import { resolveCopilotSlashCommand } from './slashCommands';

const state = {
    permissionMode: 'default' as const,
    model: 'gpt-5-mini',
    agentMode: 'interactive' as const
};

describe('resolveCopilotSlashCommand', () => {
    it('handles /status with agent mode', () => {
        const result = resolveCopilotSlashCommand('/status', {
            ...state,
            agentMode: 'autopilot'
        });
        expect(result).toMatchObject({ kind: 'handled' });
        if (result.kind === 'handled') {
            expect(result.message).toContain('autopilot');
            expect(result.message).toContain('gpt-5-mini');
        }
    });

    it('passes /fleet through without changing agent mode', () => {
        expect(resolveCopilotSlashCommand('/fleet', state)).toEqual({ kind: 'passthrough' });
        expect(resolveCopilotSlashCommand('/fleet check parser and tests', state)).toEqual({
            kind: 'passthrough'
        });
    });

    it('rejects /mode fleet as an agent mode', () => {
        const result = resolveCopilotSlashCommand('/mode fleet', state);
        expect(result).toMatchObject({ kind: 'handled' });
        if (result.kind === 'handled') {
            expect(result.message).toContain('/fleet');
            expect(result.updates).toBeUndefined();
        }
    });

    it('preserves a task supplied with /autopilot', () => {
        expect(resolveCopilotSlashCommand('/autopilot implement the fix', state)).toEqual({
            kind: 'replace',
            text: 'implement the fix',
            message: 'Copilot autopilot mode enabled',
            updates: { agentMode: 'autopilot' }
        });
    });

    it('sets model from /model', () => {
        expect(resolveCopilotSlashCommand('/model gpt-5.4', state)).toEqual({
            kind: 'handled',
            message: 'Copilot model set to gpt-5.4',
            updates: { model: 'gpt-5.4' }
        });
    });

    it('passes agent slash commands through to Copilot CLI', () => {
        for (const command of [
            '/rubber-duck review this plan',
            '/security-review',
            '/research auth flow',
            '/review',
            '/skills list',
        ]) {
            expect(resolveCopilotSlashCommand(command, state)).toEqual({ kind: 'passthrough' });
        }
    });
});
