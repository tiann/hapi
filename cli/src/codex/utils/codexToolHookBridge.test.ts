import { describe, expect, it } from 'vitest';
import { CodexToolHookBridge, isCodexToolHookEvent } from './codexToolHookBridge';

function hook(overrides: Record<string, unknown>): Record<string, unknown> {
    return {
        session_id: 'session-1',
        turn_id: 'turn-1',
        cwd: '/tmp/project',
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git status --short' },
        tool_use_id: 'exec-command-1',
        ...overrides
    };
}

describe('CodexToolHookBridge', () => {
    it('maps nested Bash hooks to one CodexBash lifecycle', () => {
        const bridge = new CodexToolHookBridge();

        expect(bridge.handle(hook({}))).toEqual([expect.objectContaining({
            type: 'tool-call',
            name: 'CodexBash',
            callId: 'exec-command-1',
            input: {
                command: 'git status --short',
                cwd: '/tmp/project',
                source: 'codex-hook'
            }
        })]);
        expect(bridge.hasCompletedAllObservedNestedTools('turn-1')).toBe(false);

        expect(bridge.handle(hook({
            hook_event_name: 'PostToolUse',
            tool_response: ' M README.md\n'
        }))).toEqual([expect.objectContaining({
            type: 'tool-call-result',
            callId: 'exec-command-1',
            output: {
                stdout: ' M README.md\n',
                stderr: '',
                status: 'completed'
            }
        })]);
        expect(bridge.hasObservedNestedTool('turn-1')).toBe(true);
        expect(bridge.hasCompletedAllObservedNestedTools('turn-1')).toBe(true);
    });

    it('maps apply_patch and extracts changed file paths', () => {
        const bridge = new CodexToolHookBridge();
        const patch = [
            '*** Begin Patch',
            '*** Update File: src/a.ts',
            '@@',
            '-old',
            '+new',
            '*** Add File: src/b.ts',
            '+content',
            '*** End Patch'
        ].join('\n');

        expect(bridge.handle(hook({
            tool_name: 'apply_patch',
            tool_input: { command: patch },
            tool_use_id: 'exec-patch-1'
        }))).toEqual([expect.objectContaining({
            type: 'tool-call',
            name: 'CodexPatch',
            input: expect.objectContaining({
                patch,
                changes: {
                    'src/a.ts': { kind: 'update' },
                    'src/b.ts': { kind: 'add' }
                }
            })
        })]);
    });

    it('maps MCP hooks using their canonical tool name', () => {
        const bridge = new CodexToolHookBridge();

        expect(bridge.handle(hook({
            tool_name: 'mcp__hapi__change_title',
            tool_input: { title: 'New title' },
            tool_use_id: 'exec-mcp-1'
        }))).toEqual([expect.objectContaining({
            type: 'tool-call',
            name: 'mcp__hapi__change_title',
            input: { title: 'New title' }
        })]);

        expect(bridge.handle(hook({
            hook_event_name: 'PostToolUse',
            tool_name: 'mcp__hapi__change_title',
            tool_input: { title: 'New title' },
            tool_response: { content: [{ type: 'text', text: 'done' }] },
            tool_use_id: 'exec-mcp-1'
        }))).toEqual([expect.objectContaining({
            type: 'tool-call-result',
            callId: 'exec-mcp-1',
            output: { content: [{ type: 'text', text: 'done' }] }
        })]);
    });

    it('preserves plan and MultiAgent V2 names and inputs', () => {
        const bridge = new CodexToolHookBridge();

        expect(bridge.handle(hook({
            tool_name: 'update_plan',
            tool_input: {
                explanation: 'Starting implementation',
                plan: [{ step: 'Implement', status: 'in_progress' }]
            },
            tool_use_id: 'exec-plan-1'
        }))).toEqual([expect.objectContaining({
            type: 'tool-call',
            name: 'update_plan',
            input: {
                explanation: 'Starting implementation',
                plan: [{ step: 'Implement', status: 'in_progress' }]
            }
        })]);

        expect(bridge.handle(hook({
            tool_name: 'followup_task',
            tool_input: { target: '/root/review', message: 'Run tests' },
            tool_use_id: 'exec-agent-1'
        }))).toEqual([expect.objectContaining({
            type: 'tool-call',
            name: 'followup_task',
            input: { target: '/root/review', message: 'Run tests' }
        })]);
    });

    it('maps dynamically registered Code Mode tools', () => {
        const bridge = new CodexToolHookBridge();

        expect(bridge.handle(hook({
            tool_name: 'view_image',
            tool_input: { path: '/tmp/result.png' },
            tool_use_id: 'exec-image-1'
        }))).toEqual([expect.objectContaining({
            type: 'tool-call',
            name: 'view_image',
            input: { path: '/tmp/result.png' }
        })]);
    });

    it('waits for every runtime call produced by a loop before covering its wrapper', () => {
        const bridge = new CodexToolHookBridge();
        bridge.handle(hook({ tool_use_id: 'exec-loop-1' }));
        bridge.handle(hook({ tool_use_id: 'exec-loop-2' }));

        bridge.handle(hook({
            hook_event_name: 'PostToolUse',
            tool_response: 'first',
            tool_use_id: 'exec-loop-1'
        }));
        expect(bridge.hasCompletedAllObservedNestedTools('turn-1')).toBe(false);

        bridge.handle(hook({
            hook_event_name: 'PostToolUse',
            tool_response: 'second',
            tool_use_id: 'exec-loop-2'
        }));
        expect(bridge.hasCompletedAllObservedNestedTools('turn-1')).toBe(true);
    });

    it('ignores direct tools and subagent hooks to avoid duplicate cards', () => {
        const bridge = new CodexToolHookBridge();

        expect(bridge.handle(hook({ tool_use_id: 'call-direct-1' }))).toEqual([]);
        expect(bridge.handle(hook({ agent_id: 'child-1' }))).toEqual([]);
        expect(bridge.hasObservedNestedTool('turn-1')).toBe(false);
    });

    it('synthesizes a begin event when PostToolUse arrives first', () => {
        const bridge = new CodexToolHookBridge();
        const messages = bridge.handle(hook({
            hook_event_name: 'PostToolUse',
            tool_response: 'done'
        }));

        expect(messages).toHaveLength(2);
        expect(messages[0]).toMatchObject({ type: 'tool-call', name: 'CodexBash' });
        expect(messages[1]).toMatchObject({ type: 'tool-call-result', output: { stdout: 'done' } });
    });

    it('closes pending cards when the bridge shuts down', () => {
        const bridge = new CodexToolHookBridge();
        bridge.handle(hook({}));

        expect(bridge.finish()).toEqual([expect.objectContaining({
            type: 'tool-call-result',
            callId: 'exec-command-1',
            is_error: true,
            output: expect.objectContaining({ status: 'incomplete' })
        })]);
        expect(bridge.finish()).toEqual([]);
    });

    it('closes only the unfinished cards from a completed turn', () => {
        const bridge = new CodexToolHookBridge();
        bridge.handle(hook({ tool_use_id: 'exec-turn-1' }));
        bridge.handle(hook({ turn_id: 'turn-2', tool_use_id: 'exec-turn-2' }));

        expect(bridge.finishTurn('turn-1')).toEqual([expect.objectContaining({
            type: 'tool-call-result',
            callId: 'exec-turn-1',
            is_error: true
        })]);
        expect(bridge.finish()).toEqual([expect.objectContaining({
            callId: 'exec-turn-2'
        })]);
    });
});

describe('isCodexToolHookEvent', () => {
    it('recognizes PreToolUse and PostToolUse events', () => {
        expect(isCodexToolHookEvent({ hook_event_name: 'PreToolUse' })).toBe(true);
        expect(isCodexToolHookEvent({ hook_event_name: 'PostToolUse' })).toBe(true);
        expect(isCodexToolHookEvent({ hook_event_name: 'SessionStart' })).toBe(false);
    });
});
