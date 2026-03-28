import { AgentSessionBase, type AgentSessionBaseOptions } from '@/agent/sessionBase'
import type { ApiSessionClient } from '@/lib'
import type { PiEnhancedMode, PiThinkingLevel, PiPermissionMode } from './piTypes'

export class PiSession extends AgentSessionBase<PiEnhancedMode> {
    readonly startedBy: 'runner' | 'terminal'
    protected thinkingLevel?: PiThinkingLevel

    constructor(opts: Omit<AgentSessionBaseOptions<PiEnhancedMode>, 'sessionLabel' | 'sessionIdLabel' | 'applySessionIdToMetadata'> & {
        startedBy: 'runner' | 'terminal'
        thinkingLevel?: PiThinkingLevel
        permissionMode?: PiPermissionMode
    }) {
        super({
            ...opts,
            sessionLabel: 'PiSession',
            sessionIdLabel: 'Pi',
            applySessionIdToMetadata: (metadata, sessionId) => ({
                ...metadata,
                piSessionId: sessionId
            }),
            permissionMode: opts.permissionMode
        })
        this.startedBy = opts.startedBy
        this.thinkingLevel = opts.thinkingLevel
    }

    setThinkingLevel(level: PiThinkingLevel): void {
        this.thinkingLevel = level
    }

    getThinkingLevel(): PiThinkingLevel | undefined {
        return this.thinkingLevel
    }

    setPermissionMode = (mode: PiPermissionMode): void => {
        this.permissionMode = mode
    }

    sendAgentMessage = (message: unknown): void => {
        this.client.sendAgentMessage(message)
    }

    sendSessionEvent = (event: Parameters<ApiSessionClient['sendSessionEvent']>[0]): void => {
        this.client.sendSessionEvent(event)
    }
}
