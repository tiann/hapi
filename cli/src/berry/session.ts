import { ApiClient, ApiSessionClient } from '@/lib'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import { AgentSessionBase } from '@/agent/sessionBase'
import type { PermissionMode } from '@hapi/protocol/types'
import type { BerryMode } from './types'

/** Remote-only HAPI session wrapper for the Berry Agent ACP server. */
export class BerrySession extends AgentSessionBase<BerryMode> {
    readonly startedBy: 'runner' | 'terminal'

    constructor(opts: {
        api: ApiClient
        client: ApiSessionClient
        path: string
        logPath: string
        /** Spawn-time model override (opaque ACP config-option value). */
        model?: string
        /** Spawn-time permission mode (defaults to 'default' upstream). */
        permissionMode?: PermissionMode
        sessionId?: string | null
        messageQueue: MessageQueue2<BerryMode>
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
            sessionLabel: 'BerrySession',
            sessionIdLabel: 'Berry ACP',
            // Berry persists sessions in its own SQLite sessions.db (inside
            // its dataDir) and restores them through `session/load`
            // (agentCapabilities.loadSession — it has no session/resume).
            // Keep the native id separate from the HAPI row id.
            applySessionIdToMetadata: (metadata, sessionId) => ({
                ...metadata,
                berrySessionId: sessionId
            })
        })
        this.startedBy = opts.startedBy
    }

    setModel = (model: string | null): void => {
        this.model = model;
    };

    setPermissionMode = (mode: PermissionMode): void => {
        this.permissionMode = mode;
    };

    sendAgentMessage = (message: unknown): void => {
        this.client.sendAgentMessage(message)
    }

    sendSessionEvent = (event: Parameters<ApiSessionClient['sendSessionEvent']>[0]): void => {
        this.client.sendSessionEvent(event)
    }
}
