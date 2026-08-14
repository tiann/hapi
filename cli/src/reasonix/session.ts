import { ApiClient, ApiSessionClient } from '@/lib'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import { AgentSessionBase } from '@/agent/sessionBase'
import type { ReasonixMode, PermissionMode } from './types'

export class ReasonixSession extends AgentSessionBase<ReasonixMode> {
    readonly startedBy: 'runner' | 'terminal'
    readonly startingMode: 'remote'

    constructor(opts: {
        api: ApiClient
        client: ApiSessionClient
        path: string
        logPath: string
        sessionId: string | null
        messageQueue: MessageQueue2<ReasonixMode>
        onModeChange: (mode: 'local' | 'remote') => void
        startedBy: 'runner' | 'terminal'
        permissionMode?: PermissionMode
        model?: string | null
        effort?: string | null
    }) {
        super({
            api: opts.api,
            client: opts.client,
            path: opts.path,
            logPath: opts.logPath,
            sessionId: opts.sessionId,
            messageQueue: opts.messageQueue,
            onModeChange: opts.onModeChange,
            mode: 'remote',
            sessionLabel: 'ReasonixSession',
            sessionIdLabel: 'Reasonix',
            applySessionIdToMetadata: (metadata, sessionId, extras) => ({
                ...metadata,
                ...extras,
                reasonixSessionId: sessionId
            }),
            permissionMode: opts.permissionMode,
            model: opts.model,
            effort: opts.effort
        })

        this.startedBy = opts.startedBy
        this.startingMode = 'remote'
    }

    setPermissionMode = (mode: PermissionMode): void => {
        this.permissionMode = mode
    }

    setModel = (model: string | null): void => {
        this.model = model
    }

    setEffort = (effort: string | null): void => {
        this.effort = effort
    }

    sendAgentMessage = (message: unknown): void => {
        this.client.sendAgentMessage(message)
    }

    sendSessionEvent = (event: Parameters<ApiSessionClient['sendSessionEvent']>[0]): void => {
        this.client.sendSessionEvent(event)
    }
}
