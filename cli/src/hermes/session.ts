import { ApiClient, ApiSessionClient } from '@/lib'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import { AgentSessionBase } from '@/agent/sessionBase'
import type { HermesPermissionMode } from '@hapi/protocol/modes'
import type { HermesMode } from './types'

/** Remote-only HAPI session wrapper for the Hermes ACP server. */
export class HermesSession extends AgentSessionBase<HermesMode> {
    readonly startedBy: 'runner' | 'terminal'

    constructor(opts: {
        api: ApiClient
        client: ApiSessionClient
        path: string
        logPath: string
        model?: string
        permissionMode?: HermesPermissionMode
        sessionId?: string | null
        messageQueue: MessageQueue2<HermesMode>
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
            sessionLabel: 'HermesSession',
            sessionIdLabel: 'Hermes ACP',
            applySessionIdToMetadata: (metadata, sessionId) => ({
                ...metadata,
                hermesSessionId: sessionId
            })
        })
        this.startedBy = opts.startedBy
        this.permissionMode = opts.permissionMode
    }

    setPermissionMode = (mode: HermesPermissionMode): void => {
        this.permissionMode = mode
    }

    setModel = (model: string | null): void => {
        this.model = model
    }

    sendAgentMessage = (message: unknown): void => {
        this.client.sendAgentMessage(message)
    }

    sendSessionEvent = (event: Parameters<ApiSessionClient['sendSessionEvent']>[0]): void => {
        this.client.sendSessionEvent(event)
    }
}
