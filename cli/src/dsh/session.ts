import { ApiClient, ApiSessionClient } from '@/lib'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import { AgentSessionBase } from '@/agent/sessionBase'
import type { DshMode } from './types'

/** Remote-only HAPI session wrapper for the DSH ACP server. */
export class DshSession extends AgentSessionBase<DshMode> {
    readonly startedBy: 'runner' | 'terminal'

    constructor(opts: {
        api: ApiClient
        client: ApiSessionClient
        path: string
        logPath: string
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

    sendAgentMessage = (message: unknown): void => {
        this.client.sendAgentMessage(message)
    }

    sendSessionEvent = (event: Parameters<ApiSessionClient['sendSessionEvent']>[0]): void => {
        this.client.sendSessionEvent(event)
    }
}
