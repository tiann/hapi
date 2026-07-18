import type { GrokPermissionMode } from '@hapi/protocol/types';

export type GrokSandboxProfile = 'workspace' | 'read-only' | 'off';

export function getGrokSandboxProfile(
    permissionMode: GrokPermissionMode = 'default'
): GrokSandboxProfile {
    switch (permissionMode) {
        case 'read-only':
            return 'read-only';
        case 'yolo':
            return 'off';
        case 'default':
        case 'safe-yolo':
            return 'workspace';
    }
}

export function hasSameGrokSandboxProfile(
    current: GrokPermissionMode,
    next: GrokPermissionMode
): boolean {
    return getGrokSandboxProfile(current) === getGrokSandboxProfile(next);
}
