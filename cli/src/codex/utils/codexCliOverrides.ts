export type CodexCliOverrides = {
    sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
    approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never';
};

const SANDBOX_VALUES = new Set<CodexCliOverrides['sandbox']>([
    'read-only',
    'workspace-write',
    'danger-full-access'
]);

const APPROVAL_POLICY_VALUES = new Set<CodexCliOverrides['approvalPolicy']>([
    'untrusted',
    'on-failure',
    'on-request',
    'never'
]);

export function parseCodexCliOverrides(args?: string[]): CodexCliOverrides {
    const overrides: CodexCliOverrides = {};
    if (!args || args.length === 0) {
        return overrides;
    }

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--') {
            break;
        }

        if (arg === '--full-auto') {
            overrides.approvalPolicy = 'on-request';
            overrides.sandbox = 'workspace-write';
            continue;
        }

        if (arg === '--dangerously-bypass-approvals-and-sandbox') {
            overrides.approvalPolicy = 'never';
            overrides.sandbox = 'danger-full-access';
            continue;
        }

        if (arg === '-s' || arg === '--sandbox') {
            const value = args[i + 1];
            if (SANDBOX_VALUES.has(value as CodexCliOverrides['sandbox'])) {
                overrides.sandbox = value as CodexCliOverrides['sandbox'];
                i += 1;
            }
            continue;
        }

        if (arg.startsWith('--sandbox=')) {
            const value = arg.slice('--sandbox='.length);
            if (SANDBOX_VALUES.has(value as CodexCliOverrides['sandbox'])) {
                overrides.sandbox = value as CodexCliOverrides['sandbox'];
            }
            continue;
        }

        if (arg === '-a' || arg === '--ask-for-approval') {
            const value = args[i + 1];
            if (APPROVAL_POLICY_VALUES.has(value as CodexCliOverrides['approvalPolicy'])) {
                overrides.approvalPolicy = value as CodexCliOverrides['approvalPolicy'];
                i += 1;
            }
            continue;
        }

        if (arg.startsWith('--ask-for-approval=')) {
            const value = arg.slice('--ask-for-approval='.length);
            if (APPROVAL_POLICY_VALUES.has(value as CodexCliOverrides['approvalPolicy'])) {
                overrides.approvalPolicy = value as CodexCliOverrides['approvalPolicy'];
            }
        }
    }

    return overrides;
}

export function hasCodexCliOverrides(overrides?: CodexCliOverrides): boolean {
    return Boolean(overrides?.sandbox || overrides?.approvalPolicy);
}
