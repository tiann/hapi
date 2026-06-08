import type { EnhancedMode } from '../loop';
import type { CodexCliOverrides } from './codexCliOverrides';
import type { McpServersConfig } from './buildHapiMcpBridge';
import { codexSystemPrompt } from './systemPrompt';
import type {
    ApprovalPolicy,
    SandboxMode,
    SandboxPolicy,
    ThreadStartParams,
    TurnStartParams,
    UserInput
} from '../appServerTypes';
import { resolveCodexPermissionModeConfig } from './permissionModeConfig';

export const codexCollaborationSpawnAgentInstructions = [
    'Codex sub-agent spawning rules:',
    '- Treat omitted fork_context the same as fork_context: true: a full-history fork inherits the parent agent type, model, and reasoning effort.',
    '- If you call spawn_agent with fork_context omitted or true, do not set agent_type, model, or reasoning_effort.',
    '- If you need a specific agent_type, model, or reasoning_effort, set fork_context: false and include only the necessary context in the message.',
    '- Do not rely on parent turn reasoning settings for spawned agents; only set reasoning_effort on spawn_agent when the chosen child model supports it.'
].join('\n');

const MODELS_WITHOUT_REASONING_SUMMARY = new Set([
    'gpt-5.3-codex-spark'
]);

function resolveApprovalPolicy(mode: EnhancedMode): ApprovalPolicy {
    return resolveCodexPermissionModeConfig(mode.permissionMode).approvalPolicy;
}

function resolveSandbox(mode: EnhancedMode): SandboxMode {
    return resolveCodexPermissionModeConfig(mode.permissionMode).sandbox;
}

function resolveSandboxPolicy(mode: EnhancedMode): SandboxPolicy {
    return resolveCodexPermissionModeConfig(mode.permissionMode).sandboxPolicy;
}

function resolveSandboxPolicyOverride(value: CodexCliOverrides['sandbox'] | undefined): SandboxPolicy | undefined {
    switch (value) {
        case 'read-only':
            return { type: 'readOnly' };
        case 'workspace-write':
            return { type: 'workspaceWrite' };
        case 'danger-full-access':
            return { type: 'dangerFullAccess' };
        default:
            return undefined;
    }
}

export function supportsReasoningSummary(model: string | undefined): boolean {
    const normalized = model?.trim().toLowerCase();
    if (!normalized) return true;
    const modelName = normalized.split('/').pop() ?? normalized;
    return !MODELS_WITHOUT_REASONING_SUMMARY.has(modelName);
}

function buildMcpServerConfig(mcpServers: McpServersConfig): Record<string, unknown> {
    const config: Record<string, unknown> = {};

    for (const [name, server] of Object.entries(mcpServers)) {
        config[`mcp_servers.${name}`] = {
            command: server.command,
            args: server.args
        };
    }

    return config;
}

function resolveInstructions(args: {
    baseInstructions?: string;
    developerInstructions?: string;
}): { baseInstructions: string; developerInstructions: string } {
    const baseInstructions = args.baseInstructions ?? codexSystemPrompt;
    const developerInstructions = args.developerInstructions
        ? `${baseInstructions}\n\n${args.developerInstructions}`
        : baseInstructions;
    return {
        baseInstructions,
        developerInstructions
    };
}

function appendCollaborationInstructions(developerInstructions: string): string {
    return `${developerInstructions}\n\n${codexCollaborationSpawnAgentInstructions}`;
}

function mentionNameFromPath(path: string): string {
    const parts = path.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] ?? path;
}

export function buildUserInputFromMessage(message: string): UserInput[] {
    const inputs: UserInput[] = [];
    const mentionPattern = /(^|\s)@"((?:\\.|[^"\\])*)"/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = mentionPattern.exec(message)) !== null) {
        const prefix = match[1] ?? '';
        const rawPath = match[2] ?? '';
        const pathText = rawPath;
        const path = pathText.replace(/\\(["\\])/g, '$1');
        if (!path) continue;

        const atIndex = match.index + prefix.length;
        const textBeforeMention = message.slice(lastIndex, atIndex);
        if (textBeforeMention) {
            inputs.push({ type: 'text', text: textBeforeMention });
        }

        inputs.push({
            type: 'mention',
            name: mentionNameFromPath(path),
            path
        });
        lastIndex = mentionPattern.lastIndex - (rawPath.length - pathText.length);
    }

    const remainder = message.slice(lastIndex);
    if (remainder || inputs.length === 0) {
        inputs.push({ type: 'text', text: remainder });
    }

    return inputs;
}

export function buildThreadStartParams(args: {
    cwd: string;
    mode: EnhancedMode;
    mcpServers: McpServersConfig;
    cliOverrides?: CodexCliOverrides;
    baseInstructions?: string;
    developerInstructions?: string;
}): ThreadStartParams {
    const approvalPolicy = resolveApprovalPolicy(args.mode);
    const sandbox = resolveSandbox(args.mode);
    const allowCliOverrides = args.mode.permissionMode === 'default';
    const cliOverrides = allowCliOverrides ? args.cliOverrides : undefined;
    const resolvedApprovalPolicy = cliOverrides?.approvalPolicy ?? approvalPolicy;
    const resolvedSandbox = cliOverrides?.sandbox ?? sandbox;

    const config = buildMcpServerConfig(args.mcpServers);
    const {
        baseInstructions,
        developerInstructions: resolvedDeveloperInstructions
    } = resolveInstructions(args);
    const configWithInstructions = {
        ...config,
        developer_instructions: resolvedDeveloperInstructions,
        ...(args.mode.modelReasoningEffort ? { model_reasoning_effort: args.mode.modelReasoningEffort } : {})
    };

    const params: ThreadStartParams = {
        cwd: args.cwd,
        approvalPolicy: resolvedApprovalPolicy,
        sandbox: resolvedSandbox,
        baseInstructions,
        developerInstructions: resolvedDeveloperInstructions,
        ...(Object.keys(configWithInstructions).length > 0 ? { config: configWithInstructions } : {})
    };

    if (args.mode.model) {
        params.model = args.mode.model;
    }

    return params;
}

export function buildTurnStartParams(args: {
    threadId: string;
    message: string;
    cwd: string;
    mode?: EnhancedMode;
    cliOverrides?: CodexCliOverrides;
    baseInstructions?: string;
    developerInstructions?: string;
    overrides?: {
        approvalPolicy?: TurnStartParams['approvalPolicy'];
        sandboxPolicy?: TurnStartParams['sandboxPolicy'];
        model?: string;
        suppressCollaborationMode?: boolean;
    };
}): TurnStartParams {
    const params: TurnStartParams = {
        threadId: args.threadId,
        cwd: args.cwd,
        input: buildUserInputFromMessage(args.message)
    };

    const allowCliOverrides = args.mode?.permissionMode === 'default';
    const cliOverrides = allowCliOverrides ? args.cliOverrides : undefined;
    const approvalPolicy = args.overrides?.approvalPolicy
        ?? cliOverrides?.approvalPolicy
        ?? (args.mode ? resolveApprovalPolicy(args.mode) : undefined);
    if (approvalPolicy) {
        params.approvalPolicy = approvalPolicy;
    }

    const sandboxPolicy = args.overrides?.sandboxPolicy
        ?? resolveSandboxPolicyOverride(cliOverrides?.sandbox)
        ?? (args.mode ? resolveSandboxPolicy(args.mode) : undefined);
    if (sandboxPolicy) {
        params.sandboxPolicy = sandboxPolicy;
    }

    const collaborationMode = args.overrides?.suppressCollaborationMode
        ? undefined
        : args.mode?.collaborationMode;
    const model = args.overrides?.model ?? args.mode?.model;
    const modelReasoningEffort = args.mode?.modelReasoningEffort;

    if (modelReasoningEffort) {
        params.effort = modelReasoningEffort;
        if (!collaborationMode && supportsReasoningSummary(model)) {
            params.summary = 'detailed';
        }
    }

    if (collaborationMode) {
        if (!model) {
            throw new Error(`Collaboration mode '${collaborationMode}' requires a resolved model`);
        }
        const { developerInstructions } = resolveInstructions(args);
        params.collaborationMode = {
            mode: collaborationMode,
            settings: {
                model,
                reasoning_effort: modelReasoningEffort ?? null,
                developer_instructions: appendCollaborationInstructions(developerInstructions)
            }
        };
    } else if (model) {
        params.model = model;
    }

    return params;
}
