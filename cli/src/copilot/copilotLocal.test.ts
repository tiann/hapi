import { afterEach, describe, expect, it } from 'vitest';
import { buildCopilotLocalArgs } from './copilotLocal';

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

afterEach(() => {
    if (originalPlatformDescriptor) Object.defineProperty(process, 'platform', originalPlatformDescriptor);
});

describe('buildCopilotLocalArgs', () => {
    it('builds resume, model, approval, and mode arguments', () => {
        expect(buildCopilotLocalArgs({ sessionId: 'session-1', model: 'gpt-5', yolo: true, agentMode: 'plan' }))
            .toEqual(['--resume=session-1', '--model', 'gpt-5', '--allow-all', '--mode', 'plan']);
    });

    it('rejects shell metacharacters in dynamic Windows arguments', () => {
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

        expect(() => buildCopilotLocalArgs({ sessionId: 'session&whoami' })).toThrow('Invalid sessionId');
        expect(() => buildCopilotLocalArgs({ sessionId: 'session-1', model: 'gpt|whoami' })).toThrow('Invalid model');
    });
});
