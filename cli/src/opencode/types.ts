import type { OpencodePermissionMode } from '@hapi/protocol/types';

export type PermissionMode = OpencodePermissionMode;

export interface OpencodeMode {
    permissionMode: PermissionMode;
    model?: string;
    modelReasoningEffort?: string | null;
}

export type OpencodeHookEvent = {
    event: string;
    payload: unknown;
    sessionId?: string;
};
