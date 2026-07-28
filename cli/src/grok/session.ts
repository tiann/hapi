import { ApiClient, ApiSessionClient } from '@/lib'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import { AgentSessionBase } from '@/agent/sessionBase'
import type { GrokMode, PermissionMode } from './types'
import type { LocalLaunchExitReason } from '@/agent/localLaunchPolicy'

type LocalLaunchFailure = {
    message: string
    exitReason: LocalLaunchExitReason
}

export class GrokSession extends AgentSessionBase<GrokMode> {
    readonly startedBy: 'runner' | 'terminal'
    readonly startingMode: 'local' | 'remote'
    localLaunchFailure: LocalLaunchFailure | null = null
    private nativeSessionExists: boolean

    constructor(opts: {
        api: ApiClient
        client: ApiSessionClient
        path: string
        logPath: string
        sessionId: string | null
        messageQueue: MessageQueue2<GrokMode>
        onModeChange: (mode: 'local' | 'remote') => void
        mode?: 'local' | 'remote'
        startedBy: 'runner' | 'terminal'
        startingMode: 'local' | 'remote'
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
            mode: opts.mode,
            sessionLabel: 'GrokSession',
            sessionIdLabel: 'Grok',
            applySessionIdToMetadata: (metadata, sessionId) => ({
                ...metadata,
                grokSessionId: sessionId
            }),
            permissionMode: opts.permissionMode,
            model: opts.model,
            effort: opts.effort
        })

        this.startedBy = opts.startedBy
        this.startingMode = opts.startingMode
        this.nativeSessionExists = opts.sessionId !== null
    }

    registerPendingNativeSession = (sessionId: string): void => {
        this.onSessionFound(sessionId)
        this.nativeSessionExists = false
    }

    registerExistingNativeSession = (sessionId: string): void => {
        this.onSessionFound(sessionId)
        this.nativeSessionExists = true
    }

    shouldResumeNativeSession = (): boolean => this.nativeSessionExists

    markNativeSessionStarted = (): void => {
        this.nativeSessionExists = true
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

    recordLocalLaunchFailure = (message: string, exitReason: LocalLaunchExitReason): void => {
        this.localLaunchFailure = { message, exitReason }
    }

    sendAgentMessage = (message: unknown): void => {
        this.client.sendAgentMessage(message)
    }

    sendSessionEvent = (event: Parameters<ApiSessionClient['sendSessionEvent']>[0]): void => {
        this.client.sendSessionEvent(event)
    }
}
