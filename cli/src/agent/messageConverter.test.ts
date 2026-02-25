import { describe, expect, it } from 'vitest';
import { convertAgentMessage } from './messageConverter';

describe('convertAgentMessage', () => {
    it('keeps tool-call status when converting ACP tool events', () => {
        const converted = convertAgentMessage({
            type: 'tool_call',
            id: 'call-1',
            name: 'Bash',
            input: { cmd: 'echo test' },
            status: 'completed'
        });

        expect(converted).toEqual({
            type: 'tool-call',
            callId: 'call-1',
            name: 'Bash',
            input: { cmd: 'echo test' },
            status: 'completed'
        });
    });

    it('marks failed tool results as error', () => {
        const converted = convertAgentMessage({
            type: 'tool_result',
            id: 'call-2',
            output: { message: 'boom' },
            status: 'failed'
        });

        expect(converted).toEqual({
            type: 'tool-call-result',
            callId: 'call-2',
            output: { message: 'boom' },
            is_error: true
        });
    });
});
