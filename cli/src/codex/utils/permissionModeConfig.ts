import type { CodexPermissionMode } from '@hapi/protocol/types';
import type { ApprovalPolicy, SandboxMode, SandboxPolicy } from '../appServerTypes';

export type CodexPermissionModeConfig = {
    approvalPolicy: ApprovalPolicy;
    sandbox: SandboxMode;
    sandboxPolicy: SandboxPolicy;
};

export function resolveCodexPermissionModeConfig(mode: CodexPermissionMode): CodexPermissionModeConfig {
    switch (mode) {
        case 'default':
            return {
                // Remote Codex sessions rely on HAPI's approval UI for sandbox escalation.
                // `on-request` keeps workspace-write sandboxing while still surfacing a
                // user-approvable elevation request when the model needs it.
                approvalPolicy: 'on-request',
                sandbox: 'workspace-write',
                sandboxPolicy: { type: 'workspaceWrite' }
            };
        case 'read-only':
            return {
                approvalPolicy: 'never',
                sandbox: 'read-only',
                sandboxPolicy: { type: 'readOnly' }
            };
        case 'safe-yolo':
            return {
                // Keep escalation available when the workspace-write sandbox blocks a command.
                approvalPolicy: 'on-failure',
                sandbox: 'workspace-write',
                sandboxPolicy: { type: 'workspaceWrite' }
            };
        case 'yolo':
            return {
                approvalPolicy: 'never',
                sandbox: 'danger-full-access',
                sandboxPolicy: { type: 'dangerFullAccess' }
            };
    }

    const unexpectedMode: never = mode;
    throw new Error(`Unknown permission mode: ${unexpectedMode}`);
}

export function buildCodexPermissionModeCliArgs(mode: Exclude<CodexPermissionMode, 'default'>): string[] {
    const config = resolveCodexPermissionModeConfig(mode);
    return ['--ask-for-approval', config.approvalPolicy, '--sandbox', config.sandbox];
}
