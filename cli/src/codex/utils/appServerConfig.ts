import type { EnhancedMode } from '../loop';
import type { CodexCliOverrides } from './codexCliOverrides';
import type { McpServersConfig } from './buildHapiMcpBridge';
import { codexSystemPrompt } from './systemPrompt';
import type {
    ApprovalPolicy,
    SandboxMode,
    SandboxPolicy,
    ThreadStartParams,
    TurnStartParams
} from '../appServerTypes';

function resolveApprovalPolicy(mode: EnhancedMode): ApprovalPolicy {
    switch (mode.permissionMode) {
        case 'default': return 'untrusted';
        case 'read-only': return 'never';
        case 'safe-yolo': return 'on-failure';
        case 'yolo': return 'on-failure';
        default: {
            throw new Error(`Unknown permission mode: ${mode.permissionMode}`);
        }
    }
}

function resolveSandbox(mode: EnhancedMode): SandboxMode {
    switch (mode.permissionMode) {
        case 'default': return 'workspace-write';
        case 'read-only': return 'read-only';
        case 'safe-yolo': return 'workspace-write';
        case 'yolo': return 'danger-full-access';
        default: {
            throw new Error(`Unknown permission mode: ${mode.permissionMode}`);
        }
    }
}

function resolveSandboxPolicy(mode: EnhancedMode): SandboxPolicy {
    switch (mode.permissionMode) {
        case 'default': return { type: 'workspaceWrite' };
        case 'read-only': return { type: 'readOnly' };
        case 'safe-yolo': return { type: 'workspaceWrite' };
        case 'yolo': return { type: 'dangerFullAccess' };
        default: {
            throw new Error(`Unknown permission mode: ${mode.permissionMode}`);
        }
    }
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

export function buildThreadStartParams(args: {
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
    const baseInstructions = args.baseInstructions ?? codexSystemPrompt;
    const resolvedDeveloperInstructions = args.developerInstructions
        ? `${baseInstructions}\n\n${args.developerInstructions}`
        : baseInstructions;
    const configWithInstructions = {
        ...config,
        developer_instructions: resolvedDeveloperInstructions
    };

    const params: ThreadStartParams = {
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
    mode?: EnhancedMode;
    cliOverrides?: CodexCliOverrides;
    overrides?: {
        approvalPolicy?: TurnStartParams['approvalPolicy'];
        sandboxPolicy?: TurnStartParams['sandboxPolicy'];
        model?: string;
    };
}): TurnStartParams {
    const params: TurnStartParams = {
        threadId: args.threadId,
        input: [{ type: 'text', text: args.message }]
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

    const collaborationMode = args.mode?.collaborationMode;
    const model = args.overrides?.model ?? args.mode?.model;
    if (collaborationMode) {
        const settings = model ? { model } : undefined;
        params.collaborationMode = settings
            ? { mode: collaborationMode, settings }
            : { mode: collaborationMode };
    } else if (model) {
        params.model = model;
    }

    return params;
}
