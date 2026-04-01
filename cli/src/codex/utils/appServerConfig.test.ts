import { describe, expect, it } from 'vitest';
import { buildThreadStartParams, buildTurnStartParams } from './appServerConfig';
import { codexSystemPrompt } from './systemPrompt';

describe('appServerConfig', () => {
    const mcpServers = { hapi: { command: 'node', args: ['mcp'] } };

    it('applies CLI overrides when permission mode is default', () => {
        const params = buildThreadStartParams({
            cwd: '/workspace/project',
            mode: { permissionMode: 'default', collaborationMode: 'default' },
            mcpServers,
            cliOverrides: { sandbox: 'danger-full-access', approvalPolicy: 'never' }
        });

        expect(params.cwd).toBe('/workspace/project');
        expect(params.sandbox).toBe('danger-full-access');
        expect(params.approvalPolicy).toBe('never');
        expect(params.baseInstructions).toBe(codexSystemPrompt);
        expect(params.developerInstructions).toBe(codexSystemPrompt);
        expect(params.config).toEqual({
            'mcp_servers.hapi': {
                command: 'node',
                args: ['mcp']
            },
            developer_instructions: codexSystemPrompt
        });
    });

    it('uses on-request approvals for default Codex threads', () => {
        const params = buildThreadStartParams({
            cwd: '/workspace/project',
            mode: { permissionMode: 'default', collaborationMode: 'default' },
            mcpServers
        });

        expect(params.sandbox).toBe('workspace-write');
        expect(params.approvalPolicy).toBe('on-request');
    });

    it('ignores CLI overrides when permission mode is not default', () => {
        const params = buildThreadStartParams({
            cwd: '/workspace/project',
            mode: { permissionMode: 'yolo', collaborationMode: 'default' },
            mcpServers,
            cliOverrides: { sandbox: 'read-only', approvalPolicy: 'never' }
        });

        expect(params.sandbox).toBe('danger-full-access');
        expect(params.approvalPolicy).toBe('never');
    });

    it('keeps on-failure approvals for safe-yolo threads', () => {
        const params = buildThreadStartParams({
            cwd: '/workspace/project',
            mode: { permissionMode: 'safe-yolo', collaborationMode: 'default' },
            mcpServers
        });

        expect(params.sandbox).toBe('workspace-write');
        expect(params.approvalPolicy).toBe('on-failure');
    });

    it('concatenates custom developer instructions after base instructions', () => {
        const params = buildThreadStartParams({
            cwd: '/workspace/project',
            mode: { permissionMode: 'default', collaborationMode: 'default' },
            mcpServers,
            developerInstructions: 'Only respond in Chinese.'
        });

        expect(params.baseInstructions).toBe(codexSystemPrompt);
        expect(params.developerInstructions).toBe(`${codexSystemPrompt}\n\nOnly respond in Chinese.`);
        expect(params.config).toEqual({
            'mcp_servers.hapi': {
                command: 'node',
                args: ['mcp']
            },
            developer_instructions: `${codexSystemPrompt}\n\nOnly respond in Chinese.`
        });
    });

    it('passes model reasoning effort via thread config', () => {
        const params = buildThreadStartParams({
            cwd: '/workspace/project',
            mode: { permissionMode: 'default', modelReasoningEffort: 'xhigh', collaborationMode: 'default' },
            mcpServers
        });

        expect(params.config).toEqual({
            'mcp_servers.hapi': {
                command: 'node',
                args: ['mcp']
            },
            developer_instructions: codexSystemPrompt,
            model_reasoning_effort: 'xhigh'
        });
    });

    it('builds turn params with mode defaults', () => {
        const params = buildTurnStartParams({
            threadId: 'thread-1',
            message: 'hello',
            cwd: '/workspace/project',
            mode: {
                permissionMode: 'read-only',
                model: 'o3',
                modelReasoningEffort: 'high',
                collaborationMode: 'default'
            }
        });

        expect(params.threadId).toBe('thread-1');
        expect(params.cwd).toBe('/workspace/project');
        expect(params.input).toEqual([{ type: 'text', text: 'hello' }]);
        expect(params.approvalPolicy).toBe('never');
        expect(params.sandboxPolicy).toEqual({ type: 'readOnly' });
        expect(params.collaborationMode).toEqual({
            mode: 'default',
            settings: {
                model: 'o3',
                reasoning_effort: 'high',
                developer_instructions: codexSystemPrompt
            }
        });
        expect(params.model).toBeUndefined();
    });

    it('puts collaboration mode in turn params with model settings', () => {
        const params = buildTurnStartParams({
            threadId: 'thread-1',
            message: 'hello',
            cwd: '/workspace/project',
            mode: {
                permissionMode: 'default',
                model: 'o3',
                modelReasoningEffort: 'high',
                collaborationMode: 'plan'
            }
        });

        expect(params.collaborationMode).toEqual({
            mode: 'plan',
            settings: {
                model: 'o3',
                reasoning_effort: 'high',
                developer_instructions: codexSystemPrompt
            }
        });
        expect(params.model).toBeUndefined();
    });

    it('carries custom developer instructions into collaboration mode settings', () => {
        const params = buildTurnStartParams({
            threadId: 'thread-1',
            message: 'hello',
            cwd: '/workspace/project',
            mode: { permissionMode: 'default', model: 'o3', collaborationMode: 'plan' },
            developerInstructions: 'Only respond in Chinese.'
        });

        expect(params.collaborationMode).toEqual({
            mode: 'plan',
            settings: {
                model: 'o3',
                developer_instructions: `${codexSystemPrompt}\n\nOnly respond in Chinese.`
            }
        });
    });

    it('rejects collaboration mode payloads without a resolved model', () => {
        expect(() => buildTurnStartParams({
            threadId: 'thread-1',
            message: 'hello',
            cwd: '/workspace/project',
            mode: { permissionMode: 'default', collaborationMode: 'plan' }
        })).toThrow("Collaboration mode 'plan' requires a resolved model");
    });

    it('applies CLI overrides for turns when permission mode is default', () => {
        const params = buildTurnStartParams({
            threadId: 'thread-1',
            message: 'hello',
            cwd: '/workspace/project',
            mode: { permissionMode: 'default', model: 'o3', collaborationMode: 'default' },
            cliOverrides: { sandbox: 'danger-full-access', approvalPolicy: 'never' }
        });

        expect(params.approvalPolicy).toBe('never');
        expect(params.sandboxPolicy).toEqual({ type: 'dangerFullAccess' });
        expect(params.collaborationMode).toEqual({
            mode: 'default',
            settings: {
                model: 'o3',
                developer_instructions: codexSystemPrompt
            }
        });
    });

    it('ignores CLI overrides for turns when permission mode is not default', () => {
        const params = buildTurnStartParams({
            threadId: 'thread-1',
            message: 'hello',
            cwd: '/workspace/project',
            mode: { permissionMode: 'safe-yolo', model: 'o3', collaborationMode: 'default' },
            cliOverrides: { sandbox: 'read-only', approvalPolicy: 'never' }
        });

        expect(params.approvalPolicy).toBe('on-failure');
        expect(params.sandboxPolicy).toEqual({ type: 'workspaceWrite' });
        expect(params.collaborationMode).toEqual({
            mode: 'default',
            settings: {
                model: 'o3',
                developer_instructions: codexSystemPrompt
            }
        });
    });

    it('prefers turn overrides', () => {
        const params = buildTurnStartParams({
            threadId: 'thread-1',
            message: 'hello',
            cwd: '/workspace/project',
            mode: { permissionMode: 'default', collaborationMode: 'default' },
            overrides: { approvalPolicy: 'on-request', model: 'gpt-5' }
        });

        expect(params.approvalPolicy).toBe('on-request');
        expect(params.collaborationMode).toEqual({
            mode: 'default',
            settings: {
                model: 'gpt-5',
                developer_instructions: codexSystemPrompt
            }
        });
        expect(params.model).toBeUndefined();
    });
});
