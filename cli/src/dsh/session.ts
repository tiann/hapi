import { ApiClient, ApiSessionClient } from '@/lib'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import { AgentSessionBase } from '@/agent/sessionBase'
import type { PermissionMode } from '@hapi/protocol/types'
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
        sessionId?: string | null
        messageQueue: MessageQueue2<DshMode>
        onModeChange: (mode: 'local' | 'remote') => void
        startedBy: 'runner' | 'terminal'
        permissionMode?: PermissionMode
    }) {
        super({
            api: opts.api,
            client: opts.client,
            path: opts.path,
            logPath: opts.logPath,
            sessionId: opts.sessionId ?? null,
            model: opts.model,
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
            }),
            permissionMode: opts.permissionMode
        })
        this.startedBy = opts.startedBy
    }

    setModel = (model: string | null): void => {
        this.model = model;
    };

    /** Runtime permission-mode updates (SetSessionConfig RPC). Writes the
     *  inherited field so `getPermissionMode()` — read by the ACP permission
     *  bridge on every permission request — sees the change immediately. */
    setPermissionMode = (mode: PermissionMode): void => {
        this.permissionMode = mode
    }

    sendAgentMessage = (message: unknown): void => {
        this.client.sendAgentMessage(message)
    }

    sendSessionEvent = (event: Parameters<ApiSessionClient['sendSessionEvent']>[0]): void => {
        this.client.sendSessionEvent(event)
    }
}
