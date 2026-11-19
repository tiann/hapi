import { describe, expect, test } from 'vitest';
import { buildCopilotAcpArgs } from './copilotBackend';

describe('buildCopilotAcpArgs', () => {
    test('defaults to acp stdio without mode', () => {
        expect(buildCopilotAcpArgs()).toEqual(['--acp', '--stdio']);
        expect(buildCopilotAcpArgs({ agentMode: 'interactive' })).toEqual(['--acp', '--stdio']);
    });

    test('passes --mode for plan and autopilot', () => {
        expect(buildCopilotAcpArgs({ agentMode: 'plan' })).toEqual(['--acp', '--stdio', '--mode', 'plan']);
        expect(buildCopilotAcpArgs({ agentMode: 'autopilot' })).toEqual([
            '--acp',
            '--stdio',
            '--mode',
            'autopilot'
        ]);
    });
});
