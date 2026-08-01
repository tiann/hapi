import type { OpencodePermissionMode } from '@hapi/protocol/types';

export type PermissionMode = OpencodePermissionMode;

export interface OpencodeMode {
    permissionMode: PermissionMode;
    // `string` is a specific model id; `null` means "reset to the backend's
    // launch-time default" (e.g. after `/model default`); `undefined` means
    // "no change requested for this batch".
    model?: string | null;
    modelReasoningEffort?: string | null;
    // Marks this queued item as a /compact request rather than a regular
    // prompt turn. Pushed via `messageQueue.pushIsolated(...)` so it never
    // batches with sibling prompts but still occupies its actual FIFO
    // position — the launcher's dequeue loop branches on this instead of
    // calling `backend.prompt()`, which keeps /compact from "cutting in
    // line" ahead of prompts that were already queued when it arrived.
    // `undefined` for normal prompts.
    operation?: 'compact' | 'clear';
}

export type OpencodeHookEvent = {
    event: string;
    payload: unknown;
    sessionId?: string;
};
