import type { AgyPermissionMode } from '@hapi/protocol/types';
import type { SessionEffort, SessionModel } from '@/api/types';

export type PermissionMode = AgyPermissionMode;

/**
 * Per-batch spawn config captured at enqueue time. MessageQueue2 batches
 * messages by mode hash, so a prompt queued while the session runs on model A
 * must keep spawning on A even if the user switches the session to B before
 * dequeue — otherwise the queued prompt silently runs on a different model
 * (and two prompts around the switch could be merged into one B turn).
 */
export interface AgyMode {
    permissionMode: PermissionMode;
    model?: SessionModel;
    effort?: SessionEffort;
}
