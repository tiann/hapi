import { describe, expect, it } from 'vitest';
import { resolveCodexPermissionModeConfig } from './permissionModeConfig';

describe('resolveCodexPermissionModeConfig', () => {
    it('uses on-request approvals for default mode', () => {
        expect(resolveCodexPermissionModeConfig('default')).toEqual({
            approvalPolicy: 'on-request',
            sandbox: 'workspace-write',
            sandboxPolicy: { type: 'workspaceWrite' }
        });
    });

    it('keeps safe-yolo escalation available with a supported approval policy', () => {
        expect(resolveCodexPermissionModeConfig('safe-yolo')).toEqual({
            approvalPolicy: 'on-request',
            sandbox: 'workspace-write',
            sandboxPolicy: { type: 'workspaceWrite' }
        });
    });
});
