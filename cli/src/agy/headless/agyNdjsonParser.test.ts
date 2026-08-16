import { describe, expect, it } from 'vitest';
import { AgyPlannerAccumulator, parseAgyNdjsonLine, toolNameToEntryType } from './agyNdjsonParser';

describe('parseAgyNdjsonLine', () => {
    it('parses the init event with conversation_id', () => {
        const event = parseAgyNdjsonLine('{"event":"init","conversation_id":"abc-123","init":{"cwd":"/tmp","tools":["run_command"],"permission_mode":"request-review"}}');
        expect(event).toEqual({ kind: 'init', conversationId: 'abc-123' });
    });

    it('parses a user_input step', () => {
        const event = parseAgyNdjsonLine('{"event":"step_update","step_update":{"conversation_id":"abc","step_index":0,"state":"DONE","step_type":"user_input"}}');
        expect(event).toEqual({ kind: 'user-input', stepIndex: 0, conversationId: 'abc' });
    });

    it('parses an agent_response text_delta (ACTIVE and DONE)', () => {
        const active = parseAgyNdjsonLine('{"event":"step_update","step_update":{"conversation_id":"abc","step_index":2,"state":"ACTIVE","step_type":"agent_response","text_delta":"OK"}}');
        expect(active).toEqual({ kind: 'planner-delta', stepIndex: 2, delta: 'OK', isDone: false, conversationId: 'abc' });
        const done = parseAgyNdjsonLine('{"event":"step_update","step_update":{"conversation_id":"abc","step_index":2,"state":"DONE","step_type":"agent_response","text_delta":"\\n","duration_seconds":2.4,"usage":{"input_tokens":1}}}');
        expect(done).toEqual({ kind: 'planner-delta', stepIndex: 2, delta: '\n', isDone: true, conversationId: 'abc' });
    });

    it('parses a tool step with parameters and output', () => {
        const active = parseAgyNdjsonLine('{"event":"step_update","step_update":{"conversation_id":"abc","step_index":3,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"echo hi"}}}}');
        expect(active).toMatchObject({
            kind: 'tool',
            isDone: false,
            entry: { step_index: 3, type: 'RUN_COMMAND', content: '' },
            toolCall: { name: 'run_command', args: { CommandLine: 'echo hi' } },
        });
        const done = parseAgyNdjsonLine('{"event":"step_update","step_update":{"conversation_id":"abc","step_index":3,"state":"DONE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"echo hi"},"output":"hi\\r\\n"}}}');
        expect(done).toMatchObject({
            kind: 'tool',
            isDone: true,
            entry: { type: 'RUN_COMMAND', content: 'hi\r\n' },
        });
    });

    it('ignores malformed result envelopes', () => {
        expect(parseAgyNdjsonLine('{"event":"result"}')).toEqual({ kind: 'ignored', reason: 'result without payload' });
        expect(parseAgyNdjsonLine('{"event":"result","result":{}}')).toEqual({ kind: 'ignored', reason: 'result without status' });
    });

    it('parses a FAILURE result envelope', () => {
        const event = parseAgyNdjsonLine('{"event":"result","result":{"conversation_id":"abc","status":"FAILURE","response":""}}');
        expect(event).toEqual({ kind: 'result', conversationId: 'abc', status: 'FAILURE', response: '' });
    });

    it('parses the result envelope', () => {
        const event = parseAgyNdjsonLine('{"event":"result","result":{"conversation_id":"abc","status":"SUCCESS","response":"OK\\n","duration_seconds":3.4,"num_turns":1,"usage":{"input_tokens":1}}}');
        expect(event).toEqual({
            kind: 'result',
            conversationId: 'abc',
            status: 'SUCCESS',
            response: 'OK\n',
        });
    });

    it('parses checkpoint steps', () => {
        const event = parseAgyNdjsonLine('{"event":"step_update","step_update":{"conversation_id":"abc","step_index":4,"state":"DONE","step_type":"checkpoint","duration_seconds":0.7,"usage":{}}}');
        expect(event).toEqual({ kind: 'checkpoint', stepIndex: 4, conversationId: 'abc' });
    });

    it('tolerates malformed lines', () => {
        expect(parseAgyNdjsonLine('')).toEqual({ kind: 'ignored', reason: 'empty line' });
        expect(parseAgyNdjsonLine('not json')).toEqual({ kind: 'ignored', reason: 'not json' });
        expect(parseAgyNdjsonLine('42')).toEqual({ kind: 'ignored', reason: 'not an object' });
        expect(parseAgyNdjsonLine('{"event":"wat"}')).toEqual({ kind: 'ignored', reason: 'unknown event wat' });
        expect(parseAgyNdjsonLine('{"event":"init"}')).toEqual({ kind: 'ignored', reason: 'init without conversation_id' });
        expect(parseAgyNdjsonLine('{"event":"step_update","step_update":{"step_index":1,"state":"DONE","step_type":"unknown","duration_seconds":0.001}}'))
            .toEqual({ kind: 'ignored', reason: 'unhandled step_type unknown (state DONE)' });
    });

    it('ignores agent_response ACTIVE lines without text', () => {
        const event = parseAgyNdjsonLine('{"event":"step_update","step_update":{"conversation_id":"abc","step_index":2,"state":"ACTIVE","step_type":"agent_response","duration_seconds":0.1}}');
        expect(event).toEqual({ kind: 'ignored', reason: 'agent_response without text_delta' });
    });
});

describe('toolNameToEntryType', () => {
    it('converts snake_case tool ids to SCREAMING_SNAKE entry types', () => {
        expect(toolNameToEntryType('run_command')).toBe('RUN_COMMAND');
        expect(toolNameToEntryType('view_file')).toBe('VIEW_FILE');
        expect(toolNameToEntryType('replace_file_content')).toBe('REPLACE_FILE_CONTENT');
    });
});

describe('AgyPlannerAccumulator', () => {
    it('accumulates deltas across ACTIVE lines and flushes on DONE', () => {
        const acc = new AgyPlannerAccumulator();
        expect(acc.feedDelta(5, 'Done', false)).toBeNull();
        expect(acc.feedDelta(5, '. Output:', false)).toBeNull();
        const entry = acc.feedDelta(5, '\n```\nhi\n```', true);
        expect(entry).toMatchObject({
            step_index: 5,
            type: 'PLANNER_RESPONSE',
            content: 'Done. Output:\n```\nhi\n```',
        });
    });

    it('flushes accumulated text when DONE arrives without a trailing delta', () => {
        const acc = new AgyPlannerAccumulator();
        acc.feedDelta(5, 'partial', false);
        const entry = acc.feedDone(5);
        expect(entry).toMatchObject({ step_index: 5, content: 'partial' });
        expect(acc.isDone(5)).toBe(true);
        expect(acc.feedDone(5)).toBeNull();
    });

    it('parses an agent_response DONE line without text_delta as a step-closing event', () => {
        const event = parseAgyNdjsonLine('{"event":"step_update","step_update":{"conversation_id":"abc","step_index":2,"state":"DONE","step_type":"agent_response","duration_seconds":2.4,"usage":{}}}');
        expect(event).toEqual({ kind: 'planner-delta', stepIndex: 2, delta: '', isDone: true, conversationId: 'abc' });
    });

    it('returns null when a DONE step accumulated no text', () => {
        const acc = new AgyPlannerAccumulator();
        expect(acc.feedDelta(2, '', true)).toBeNull();
        expect(acc.hasPending(2)).toBe(false);
    });

    it('tracks done steps', () => {
        const acc = new AgyPlannerAccumulator();
        acc.feedDelta(2, 'text', true);
        expect(acc.isDone(2)).toBe(true);
        expect(acc.isDone(3)).toBe(false);
    });

    it('force-flushes pending text at result time', () => {
        const acc = new AgyPlannerAccumulator();
        acc.feedDelta(5, 'partial', false);
        expect(acc.hasPending(5)).toBe(true);
        const entry = acc.flush(5);
        expect(entry).toMatchObject({ step_index: 5, content: 'partial' });
        expect(acc.hasPending(5)).toBe(false);
        expect(acc.flush(5)).toBeNull();
    });

    it('flushAll returns every pending step in order', () => {
        const acc = new AgyPlannerAccumulator();
        acc.feedDelta(2, 'first', false);
        acc.feedDelta(5, 'second', false);
        const entries = acc.flushAll();
        expect(entries).toHaveLength(2);
        expect(entries[0]).toMatchObject({ step_index: 2, content: 'first' });
        expect(entries[1]).toMatchObject({ step_index: 5, content: 'second' });
        expect(acc.flushAll()).toHaveLength(0);
    });
});
