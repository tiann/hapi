import type { AgyPermissionMode } from '@hapi/protocol/types';

export type PermissionMode = AgyPermissionMode;

export interface AgyMode {
    permissionMode: PermissionMode;
    model?: string;
}
