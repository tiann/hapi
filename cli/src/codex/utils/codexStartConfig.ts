import type { CodexSessionConfig } from '../types';
import type { EnhancedMode } from '../loop';
import type { CodexCliOverrides } from './codexCliOverrides';
import { codexSystemPrompt } from './systemPrompt';

function resolveApprovalPolicy(mode: EnhancedMode): CodexSessionConfig['approval-policy'] {
    switch (mode.permissionMode) {
        case 'default': return 'untrusted';
        case 'read-only': return 'never';
        case 'safe-yolo': return 'on-failure';
        case 'yolo': return 'never';
        default: {
            throw new Error(`Unknown permission mode: ${mode.permissionMode}`);
        }
    }
}

function resolveSandbox(mode: EnhancedMode): CodexSessionConfig['sandbox'] {
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

export function buildCodexStartConfig(args: {
    message: string;
    mode: EnhancedMode;
    first: boolean;
    mcpServers: Record<string, { command: string; args: string[] }>;
    cliOverrides?: CodexCliOverrides;
    developerInstructions?: string;
}): CodexSessionConfig {
    const approvalPolicy = resolveApprovalPolicy(args.mode);
    const sandbox = resolveSandbox(args.mode);
    const allowCliOverrides = args.mode.permissionMode === 'default';
    const cliOverrides = allowCliOverrides ? args.cliOverrides : undefined;
    const resolvedApprovalPolicy = cliOverrides?.approvalPolicy ?? approvalPolicy;
    const resolvedSandbox = cliOverrides?.sandbox ?? sandbox;

    const prompt = args.message;
    const baseInstructions = codexSystemPrompt;
    const config: Record<string, unknown> = {
        mcp_servers: args.mcpServers,
        developer_instructions: args.developerInstructions
            ? `${baseInstructions}\n\n${args.developerInstructions}`
            : baseInstructions
    };
    const startConfig: CodexSessionConfig = {
        prompt,
        sandbox: resolvedSandbox,
        'approval-policy': resolvedApprovalPolicy,
        config
    };

    if (args.mode.model) {
        startConfig.model = args.mode.model;
    }

    return startConfig;
}
