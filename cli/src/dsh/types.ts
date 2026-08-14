import type { DshPermissionMode } from '@hapi/protocol/types';

export type PermissionMode = DshPermissionMode;

export interface DshMode {
    permissionMode: PermissionMode;
    model?: string;
}
