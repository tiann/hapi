import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@/agent/types';
import { mapAgyToolCall, mapAgyToolResult, AGY_BACKGROUND_COMMAND_RESULT } from './agyToolCards';

type ToolCall = Extract<AgentMessage, { type: 'tool_call' }>;

function call(nativeName: string, args: Record<string, unknown>, extra: Partial<ToolCall> = {}): ToolCall {
    return {
        type: 'tool_call',
        id: 'call_1',
        name: 'some title',
        input: args,
        status: 'in_progress',
        title: 'some title',
        kind: 'other',
        nativeName,
        nativeArgs: args,
        ...extra
    };
}

describe('mapAgyToolCall', () => {
    it('maps run_command to Bash and drops the bookkeeping args', () => {
        const mapped = mapAgyToolCall(call('run_command', {
            CommandLine: 'ls -la', Cwd: '/tmp/x', WaitMsBeforeAsync: 5000, toolSummary: 'List files'
        }));
        expect(mapped).toMatchObject({
            name: 'Bash',
            input: { command: 'ls -la', cwd: '/tmp/x', description: 'List files' }
        });
        expect(mapped.input).not.toHaveProperty('WaitMsBeforeAsync');
    });

    it('maps read_file to Read', () => {
        expect(mapAgyToolCall(call('read_file', { Path: '/a/b.md' }))).toMatchObject({
            name: 'Read', input: { file_path: '/a/b.md' }
        });
    });

    it('maps edit_file to an Edit diff input', () => {
        expect(mapAgyToolCall(call('edit_file', { Path: '/a/b.md', Target: 'two', Replacement: 'TWO' }))).toMatchObject({
            name: 'Edit', input: { file_path: '/a/b.md', old_string: 'two', new_string: 'TWO' }
        });
    });

    it('maps write_file to Write', () => {
        expect(mapAgyToolCall(call('write_file', { Path: '/a/c.md', Content: 'hello\n' }))).toMatchObject({
            name: 'Write', input: { file_path: '/a/c.md', content: 'hello\n' }
        });
    });

    it('shows an artifact write as a plan without the brain path', () => {
        const mapped = mapAgyToolCall(call('write_file', {
            Path: '/home/u/.gemini/antigravity-cli/brain/abc/plan.md',
            Content: '- [ ] step 1\n',
            ArtifactMetadata: { Summary: 'Haiku Plan', UserFacing: true, RequestFeedback: false }
        }, { title: 'File ../../../.gemini/antigravity-cli/brain/abc/plan.md' }));
        expect(mapped.name).toBe('ExitPlanMode');
        expect(mapped.input).toEqual({ plan: '# Haiku Plan\n\n- [ ] step 1\n' });
        expect(JSON.stringify({ title: mapped.title, input: mapped.input })).not.toContain('brain');
    });

    it('keeps an artifact that starts with its own heading as is', () => {
        const mapped = mapAgyToolCall(call('write_file', {
            Path: '/x/brain/p.md', Content: '# Own title\n\nbody',
            ArtifactMetadata: { Summary: 'Other' }
        }));
        expect(mapped.input).toEqual({ plan: '# Own title\n\nbody' });
    });

    it('maps search_web to WebSearch', () => {
        expect(mapAgyToolCall(call('search_web', { query: 'acp elicitation' }))).toMatchObject({
            name: 'WebSearch', input: { query: 'acp elicitation' }
        });
    });

    it('maps invoke_subagent to Task', () => {
        expect(mapAgyToolCall(call('invoke_subagent', {
            Prompt: 'Draw it', Role: 'Image Generator', TypeName: 'image-generator', Model: 'inherit'
        }))).toMatchObject({
            name: 'Task',
            input: { description: 'Image Generator', prompt: 'Draw it', subagent_type: 'image-generator' }
        });
    });

    it('maps call_mcp_tool to the mcp card, parsing string arguments', () => {
        expect(mapAgyToolCall(call('call_mcp_tool', {
            ServerName: 'hapi', ToolName: 'change_title', Arguments: { title: 'T' }
        }))).toMatchObject({ name: 'mcp__hapi__change_title', input: { title: 'T' } });
        expect(mapAgyToolCall(call('call_mcp_tool', {
            ServerName: 'hapi', ToolName: 'change_title', Arguments: '{"title":"S"}'
        }))).toMatchObject({ name: 'mcp__hapi__change_title', input: { title: 'S' } });
    });

    it('leaves unknown agy tools, ask_question and calls without a native name alone', () => {
        const unknown = call('manage_task', { a: 1 });
        expect(mapAgyToolCall(unknown)).toBe(unknown);
        const question = call('ask_question', { questions: [] });
        expect(mapAgyToolCall(question)).toBe(question);
        const plain: ToolCall = { type: 'tool_call', id: 'x', name: 'Read', input: {}, status: 'pending' };
        expect(mapAgyToolCall(plain)).toBe(plain);
    });

    it('keeps id, status, title and kind of the mapped call', () => {
        const mapped = mapAgyToolCall(call('read_file', { Path: '/a' }, { status: 'pending', kind: 'read' }));
        expect(mapped).toMatchObject({ type: 'tool_call', id: 'call_1', status: 'pending', title: 'some title', kind: 'read' });
    });
});

describe('mapAgyToolResult', () => {
    it('strips run_command framing into stdout', () => {
        const result: Extract<AgentMessage, { type: 'tool_result' }> = {
            type: 'tool_result', id: 'c', status: 'completed',
            output: { output: 'Command exited with code 0.\n\nCommand output:\nhello\r\nworld\r\n', exit_code: 0 }
        };
        expect(mapAgyToolResult(result, 'run_command')).toMatchObject({
            output: { stdout: 'hello\nworld', exit_code: 0 }
        });
    });

    it('leaves other results alone', () => {
        const result: Extract<AgentMessage, { type: 'tool_result' }> = {
            type: 'tool_result', id: 'c', status: 'completed', output: { a: 1 }
        };
        expect(mapAgyToolResult(result, 'read_file')).toBe(result);
        expect(mapAgyToolResult(result, undefined)).toBe(result);
    });

    it('exposes the background placeholder as Bash stdout', () => {
        expect(AGY_BACKGROUND_COMMAND_RESULT).toMatchObject({ stdout: expect.stringContaining('background') });
    });
});
