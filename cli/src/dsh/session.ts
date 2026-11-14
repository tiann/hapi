import { ApiClient, ApiSessionClient } from '@/lib'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import { AgentSessionBase } from '@/agent/sessionBase'
import type { SessionModelReasoningEffort, SessionPermissionMode } from '@/api/types'
import type { DshMode } from './types'

/** Remote-only HAPI session wrapper for the DSH ACP server. */
export class DshSession extends AgentSessionBase<DshMode> {
    readonly startedBy: 'runner' | 'terminal'

    constructor(opts: {
        api: ApiClient
        client: ApiSessionClient
        path: string
        logPath: string
        /** Spawn-time model override (opaque ACP config-option value). */
        model?: string
        /** Spawn-time permission mode: pins DSH_PERMISSION_MODE on the child
         *  env (read-only / danger-full-access) and drives the ACP permission
         *  bridge's auto-approval decisions. */
        permissionMode?: SessionPermissionMode
        sessionId?: string | null
        messageQueue: MessageQueue2<DshMode>
        onModeChange: (mode: 'local' | 'remote') => void
        startedBy: 'runner' | 'terminal'
    }) {
        super({
            api: opts.api,
            client: opts.client,
            path: opts.path,
            logPath: opts.logPath,
            sessionId: opts.sessionId ?? null,
            model: opts.model,
            permissionMode: opts.permissionMode,
            messageQueue: opts.messageQueue,
            onModeChange: opts.onModeChange,
            mode: 'remote',
            sessionLabel: 'DshSession',
            sessionIdLabel: 'DeepSeek Harness ACP',
            // Current DSH ACP profiles persist sessions and resume them through
            // `session/resume`. Keep the native id separate from the HAPI row id.
            applySessionIdToMetadata: (metadata, sessionId) => ({
                ...metadata,
                dshSessionId: sessionId
            })
        })
        this.startedBy = opts.startedBy
    }

    setModel = (model: string | null): void => {
        this.model = model;
    };

    /** Runtime/rollback updates for the reasoning-effort preference: writes
     * the inherited field so the keepalive runtime (which the hub picker
     * mirrors) reports the live value — the launcher's onEffortRollback
     * corrects a failed switch through here, exactly like setModel. */
    setModelReasoningEffort = (effort: SessionModelReasoningEffort | undefined): void => {
        this.modelReasoningEffort = effort;
    };

    sendAgentMessage = (message: unknown): void => {
        this.client.sendAgentMessage(message)
    }

    sendSessionEvent = (event: Parameters<ApiSessionClient['sendSessionEvent']>[0]): void => {
        this.client.sendSessionEvent(event)
    }
}
