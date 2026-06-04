import type { OpencodePermissionMode } from '@hapi/protocol/types';

export type PermissionMode = OpencodePermissionMode;

export interface OpencodeMode {
    permissionMode: PermissionMode;
    // `string` is a specific model id; `null` means "reset to the backend's
    // launch-time default" (e.g. after `/model default`); `undefined` means
    // "no change requested for this batch".
    model?: string | null;
    modelReasoningEffort?: string | null;
}

export type OpencodeHookEvent = {
    event: string;
    payload: unknown;
    sessionId?: string;
};
