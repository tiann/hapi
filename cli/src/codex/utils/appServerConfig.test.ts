import { describe, expect, it } from 'vitest';
import type { EnhancedMode } from '../loop';
import {
    buildThreadStartParams,
    buildTurnStartParams,
    buildUserInputFromMessage,
    codexCollaborationSpawnAgentInstructions,
    supportsReasoningSummary
} from './appServerConfig';
import { codexSystemPrompt } from './systemPrompt';

describe('appServerConfig', () => {
    const mcpServers = { hapi: { command: 'node', args: ['mcp'] } };
    const withCollaborationInstructions = (developerInstructions: string): string => {
        return `${developerInstructions}\n\n${codexCollaborationSpawnAgentInstructions}`;
    };

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

    it('passes MCP per-tool approval config through thread config', () => {
        const params = buildThreadStartParams({
            cwd: '/workspace/project',
            mode: { permissionMode: 'default', collaborationMode: 'default' },
            mcpServers: {
                hapi: {
                    command: 'node',
                    args: ['mcp'],
                    tools: {
                        change_title: {
                            approval_mode: 'approve'
                        }
                    }
                }
            }
        });

        expect(params.config).toEqual({
            'mcp_servers.hapi': {
                command: 'node',
                args: ['mcp'],
                tools: {
                    change_title: {
                        approval_mode: 'approve'
                    }
                }
            },
            developer_instructions: codexSystemPrompt
        });
    });

    it('ignores CLI overrides when permission mode is not default', () => {
        const params = buildThreadStartParams({
            cwd: '/workspace/project',
            mode: { permissionMode: 'yolo', collaborationMode: 'default' },
            mcpServers,
            cliOverrides: { sandbox: 'read-only', approvalPolicy: 'never' }
        });

        expect(params.sandbox).toBe('danger-full-access');
        expect(params.approvalPolicy).toEqual({
            granular: {
                sandbox_approval: false,
                rules: false,
                skill_approval: false,
                request_permissions: false,
                mcp_elicitations: true
            }
        });
    });

    it('keeps supported escalation approvals for safe-yolo threads', () => {
        const params = buildThreadStartParams({
            cwd: '/workspace/project',
            mode: { permissionMode: 'safe-yolo', collaborationMode: 'default' },
            mcpServers
        });

        expect(params.sandbox).toBe('workspace-write');
        expect(params.approvalPolicy).toBe('on-request');
    });

    it('allows MCP elicitation without enabling sandbox prompts for read-only threads', () => {
        const params = buildThreadStartParams({
            cwd: '/workspace/project',
            mode: { permissionMode: 'read-only', collaborationMode: 'default' },
            mcpServers
        });

        expect(params.sandbox).toBe('read-only');
        expect(params.approvalPolicy).toEqual({
            granular: {
                sandbox_approval: false,
                rules: false,
                skill_approval: false,
                request_permissions: false,
                mcp_elicitations: true
            }
        });
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
            mode: { permissionMode: 'default', modelReasoningEffort: 'ultra', collaborationMode: 'default' },
            mcpServers
        });

        expect(params.config).toEqual({
            'mcp_servers.hapi': {
                command: 'node',
                args: ['mcp']
            },
            developer_instructions: codexSystemPrompt,
            model_reasoning_effort: 'ultra'
        });
    });

    it('translates Fast to the advertised app-server tier (priority) in thread params', () => {
        const params = buildThreadStartParams({
            cwd: '/workspace/project',
            mode: { permissionMode: 'default', collaborationMode: 'default', serviceTier: 'fast' },
            mcpServers
        });

        expect(params.serviceTier).toBe('priority');
    });

    it('translates explicit Standard to app-server null in thread params', () => {
        const params = buildThreadStartParams({
            cwd: '/workspace/project',
            mode: { permissionMode: 'default', collaborationMode: 'default', serviceTier: 'standard' },
            mcpServers
        });

        expect(params.serviceTier).toBeNull();
    });

    it('omits service tier from thread params when untouched (undefined or null)', () => {
        const undefinedParams = buildThreadStartParams({
            cwd: '/workspace/project',
            mode: { permissionMode: 'default', collaborationMode: 'default' },
            mcpServers
        });
        expect('serviceTier' in undefinedParams).toBe(false);

        const nullParams = buildThreadStartParams({
            cwd: '/workspace/project',
            mode: { permissionMode: 'default', collaborationMode: 'default', serviceTier: null },
            mcpServers
        });
        expect('serviceTier' in nullParams).toBe(false);
    });

    it('translates Fast to the advertised app-server tier (priority) in turn params', () => {
        const params = buildTurnStartParams({
            threadId: 'thread-1',
            message: 'hello',
            cwd: '/workspace/project',
            mode: { permissionMode: 'default', model: 'gpt-5.5', collaborationMode: 'default', serviceTier: 'fast' }
        });

        expect(params.serviceTier).toBe('priority');
    });

    it('translates explicit Standard to app-server null in turn params', () => {
        const params = buildTurnStartParams({
            threadId: 'thread-1',
            message: 'hello',
            cwd: '/workspace/project',
            mode: { permissionMode: 'default', model: 'gpt-5.5', collaborationMode: 'default', serviceTier: 'standard' }
        });

        expect(params.serviceTier).toBeNull();
    });

    it('omits service tier from turn params when untouched (undefined or null)', () => {
        const undefinedParams = buildTurnStartParams({
            threadId: 'thread-1',
            message: 'hello',
            cwd: '/workspace/project',
            mode: { permissionMode: 'default', model: 'gpt-5.5', collaborationMode: 'default' }
        });
        expect('serviceTier' in undefinedParams).toBe(false);

        const nullParams = buildTurnStartParams({
            threadId: 'thread-1',
            message: 'hello',
            cwd: '/workspace/project',
            mode: { permissionMode: 'default', model: 'gpt-5.5', collaborationMode: 'default', serviceTier: null }
        });
        expect('serviceTier' in nullParams).toBe(false);
    });

    it('forwards personality only when explicitly set on the mode', () => {
        const omitted = buildTurnStartParams({
            threadId: 'thread-1',
            message: 'hello',
            cwd: '/workspace/project',
            mode: { permissionMode: 'default', model: 'gpt-5.5', collaborationMode: 'default' }
        });
        expect('personality' in omitted).toBe(false);

        const set = buildTurnStartParams({
            threadId: 'thread-1',
            message: 'hello',
            cwd: '/workspace/project',
            mode: {
                permissionMode: 'default',
                model: 'gpt-5.5',
                collaborationMode: 'default',
                personality: 'pragmatic'
            }
        });
        expect(set.personality).toBe('pragmatic');

        const thread = buildThreadStartParams({
            cwd: '/workspace/project',
            mode: {
                permissionMode: 'default',
                model: 'gpt-5.5',
                collaborationMode: 'default',
                personality: 'friendly'
            },
            mcpServers
        });
        expect(thread.personality).toBe('friendly');
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
        expect(params.approvalPolicy).toEqual({
            granular: {
                sandbox_approval: false,
                rules: false,
                skill_approval: false,
                request_permissions: false,
                mcp_elicitations: true
            }
        });
        expect(params.sandboxPolicy).toEqual({ type: 'readOnly' });
        expect(params.effort).toBe('high');
        expect(params.summary).toBeUndefined();
        expect(params.collaborationMode).toEqual({
            mode: 'default',
            settings: {
                model: 'o3',
                reasoning_effort: 'high',
                developer_instructions: withCollaborationInstructions(codexSystemPrompt)
            }
        });
        expect(params.model).toBeUndefined();
    });

    it('omits reasoning summary for models that do not support it', () => {
        const params = buildTurnStartParams({
            threadId: 'thread-1',
            message: 'hello',
            cwd: '/workspace/project',
            mode: {
                permissionMode: 'default',
                model: 'gpt-5.3-codex-spark',
                modelReasoningEffort: 'high',
                collaborationMode: 'default'
            }
        });

        expect(params.effort).toBe('high');
        expect(params.summary).toBeUndefined();
        expect(params.collaborationMode).toEqual({
            mode: 'default',
            settings: {
                model: 'gpt-5.3-codex-spark',
                reasoning_effort: 'high',
                developer_instructions: withCollaborationInstructions(codexSystemPrompt)
            }
        });
    });

    it('detects namespaced models that do not support reasoning summary', () => {
        const params = buildTurnStartParams({
            threadId: 'thread-1',
            message: 'hello',
            cwd: '/workspace/project',
            mode: {
                permissionMode: 'default',
                model: 'codex/gpt-5.3-codex-spark',
                modelReasoningEffort: 'high',
                collaborationMode: 'default'
            }
        });

        expect(params.effort).toBe('high');
        expect(params.summary).toBeUndefined();
    });

    it('normalizes reasoning summary model support checks', () => {
        expect(supportsReasoningSummary(' Codex/GPT-5.3-CODEX-SPARK ')).toBe(false);
        expect(supportsReasoningSummary('gpt-5.5')).toBe(true);
        expect(supportsReasoningSummary(undefined)).toBe(true);
    });

    it('omits reasoning summary for non-collaboration turns on unsupported models', () => {
        const params = buildTurnStartParams({
            threadId: 'thread-1',
            message: 'hello',
            cwd: '/workspace/project',
            mode: {
                permissionMode: 'default',
                model: 'gpt-5.3-codex-spark',
                modelReasoningEffort: 'high'
            } as EnhancedMode
        });

        expect(params.effort).toBe('high');
        expect(params.summary).toBeUndefined();
        expect(params.model).toBe('gpt-5.3-codex-spark');
        expect(params.collaborationMode).toBeUndefined();
    });

    it('keeps reasoning summary for non-collaboration turns on supported models', () => {
        const params = buildTurnStartParams({
            threadId: 'thread-1',
            message: 'hello',
            cwd: '/workspace/project',
            mode: {
                permissionMode: 'default',
                model: 'o3',
                modelReasoningEffort: 'high'
            } as EnhancedMode
        });

        expect(params.effort).toBe('high');
        expect(params.summary).toBe('detailed');
        expect(params.model).toBe('o3');
        expect(params.collaborationMode).toBeUndefined();
    });

    it('keeps yolo access while using Codex built-in plan instructions', () => {
        const params = buildTurnStartParams({
            threadId: 'thread-1',
            message: 'hello',
            cwd: '/workspace/project',
            mode: {
                permissionMode: 'yolo',
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
                developer_instructions: null
            }
        });
        expect(params.sandboxPolicy).toEqual({ type: 'dangerFullAccess' });
        expect(params.model).toBeUndefined();
    });

    it('does not override Codex built-in plan instructions', () => {
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
                developer_instructions: null
            }
        });
        expect(params.collaborationMode?.settings).not.toHaveProperty('reasoning_effort');
    });

    it('injects spawn_agent argument rules into collaboration mode instructions', () => {
        const params = buildTurnStartParams({
            threadId: 'thread-1',
            message: 'hello',
            cwd: '/workspace/project',
            mode: { permissionMode: 'default', model: 'o3', collaborationMode: 'default' }
        });

        const instructions = params.collaborationMode?.settings.developer_instructions;
        expect(instructions).toContain('Treat omitted fork_context the same as fork_context: true');
        expect(instructions).toContain('do not set agent_type, model, or reasoning_effort');
        expect(instructions).toContain('set fork_context: false');
        expect(instructions).toContain('Do not rely on parent turn reasoning settings for spawned agents');
    });

    it('injects proactive multi-agent instructions when /agent mode is enabled', () => {
        const params = buildTurnStartParams({
            threadId: 'thread-1',
            message: 'work',
            cwd: '/repo',
            mode: {
                permissionMode: 'default',
                model: 'o3',
                collaborationMode: 'default',
                proactiveMultiAgent: true
            }
        });

        expect(params.collaborationMode?.settings.developer_instructions)
            .toContain('Proactive multi-agent delegation is active.');
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
                developer_instructions: withCollaborationInstructions(codexSystemPrompt)
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

        expect(params.approvalPolicy).toBe('on-request');
        expect(params.sandboxPolicy).toEqual({ type: 'workspaceWrite' });
        expect(params.collaborationMode).toEqual({
            mode: 'default',
            settings: {
                model: 'o3',
                developer_instructions: withCollaborationInstructions(codexSystemPrompt)
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
                developer_instructions: withCollaborationInstructions(codexSystemPrompt)
            }
        });
        expect(params.model).toBeUndefined();
    });

    it('can suppress collaboration mode while preserving top-level model', () => {
        const params = buildTurnStartParams({
            threadId: 'thread-1',
            message: 'hello',
            cwd: '/workspace/project',
            mode: { permissionMode: 'default', model: 'o3', collaborationMode: 'plan' },
            overrides: { suppressCollaborationMode: true }
        });

        expect(params.collaborationMode).toBeUndefined();
        expect(params.model).toBe('o3');
    });

    it('builds mention inputs from quoted @file tokens', () => {
        expect(buildUserInputFromMessage('please inspect @"src/index.ts" now')).toEqual([
            { type: 'text', text: 'please inspect ' },
            { type: 'mention', name: 'index.ts', path: 'src/index.ts' },
            { type: 'text', text: ' now' }
        ]);
    });

    it('builds a structured leading skill input from the native catalog', () => {
        expect(buildUserInputFromMessage('$hapi inspect @"README.md"', [{
            name: 'hapi',
            path: '/home/user/.agents/skills/hapi/SKILL.md',
            description: 'Manage HAPI',
            scope: 'user',
            enabled: true
        }])).toEqual([
            { type: 'skill', name: 'hapi', path: '/home/user/.agents/skills/hapi/SKILL.md' },
            { type: 'text', text: ' inspect ' },
            { type: 'mention', name: 'README.md', path: 'README.md' }
        ]);
    });

    it('keeps unknown and disabled skill references as text', () => {
        const skills = [{
            name: 'disabled-skill',
            path: '/skills/disabled/SKILL.md',
            description: 'Disabled',
            scope: 'user' as const,
            enabled: false
        }];

        expect(buildUserInputFromMessage('$unknown run', skills)).toEqual([
            { type: 'text', text: '$unknown run' }
        ]);
        expect(buildUserInputFromMessage('$disabled-skill run', skills)).toEqual([
            { type: 'text', text: '$disabled-skill run' }
        ]);
    });

    it('builds mention inputs from quoted @file tokens with spaces', () => {
        expect(buildUserInputFromMessage('please inspect @"docs/My File.md" now')).toEqual([
            { type: 'text', text: 'please inspect ' },
            { type: 'mention', name: 'My File.md', path: 'docs/My File.md' },
            { type: 'text', text: ' now' }
        ]);
    });

    it('builds mention inputs from quoted root-level @file tokens', () => {
        expect(buildUserInputFromMessage('please inspect @"package.json" now')).toEqual([
            { type: 'text', text: 'please inspect ' },
            { type: 'mention', name: 'package.json', path: 'package.json' },
            { type: 'text', text: ' now' }
        ]);
    });

    it('keeps literal at-mentions as text', () => {
        expect(buildUserInputFromMessage('please ask @alice to upgrade @types/node.')).toEqual([
            { type: 'text', text: 'please ask @alice to upgrade @types/node.' }
        ]);
    });
});
