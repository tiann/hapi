export type PluginCommandAck = {
    accepted: boolean
    upstreamRequestId: string
    upstreamConversationId: string
    retryAfterMs: number | null
}

export type PluginConfig = {
    hapiBaseUrl: string
    sharedSecret: string
    namespace: string
    prototypeCaptureSessionKey: string | null
    prototypeCaptureFileName: string
}

export type PluginHealthStatus = {
    ok: true
    pluginVersion: string
    openclawConnected: boolean
    prototypeCapture: {
        enabled: boolean
        sessionKey: string | null
        fileName: string
    }
}

export type HapiCallbackEvent =
    | {
        type: 'message'
        eventId: string
        occurredAt: number
        namespace: string
        conversationId: string
        externalMessageId: string
        role: 'user' | 'assistant' | 'system'
        content: { mode: 'replace'; text: string } | { mode: 'append'; delta: string }
        createdAt?: number
        status?: 'streaming' | 'completed' | 'failed'
    }
    | {
        type: 'approval-request'
        eventId: string
        occurredAt: number
        namespace: string
        conversationId: string
        requestId: string
        title: string
        description?: string
        createdAt?: number
    }
    | {
        type: 'approval-resolved'
        eventId: string
        occurredAt: number
        namespace: string
        conversationId: string
        requestId: string
        status: 'approved' | 'denied'
    }
    | {
        type: 'state'
        eventId: string
        occurredAt: number
        namespace: string
        conversationId: string
        connected: boolean
        thinking: boolean
        lastError?: string | null
    }

export type PluginRuntimeAction =
    | {
        kind: 'send-message'
        conversationId: string
        text: string
        localMessageId: string
    }
    | {
        kind: 'approve'
        conversationId: string
        requestId: string
    }
    | {
        kind: 'deny'
        conversationId: string
        requestId: string
    }

export type PluginRuntimeSendMessageAction = Extract<PluginRuntimeAction, { kind: 'send-message' }>
export type PluginRuntimeApproveAction = Extract<PluginRuntimeAction, { kind: 'approve' }>
export type PluginRuntimeDenyAction = Extract<PluginRuntimeAction, { kind: 'deny' }>

export interface OpenClawAdapterRuntime {
    readonly supportsApprovals: boolean
    ensureDefaultConversation(externalUserKey: string): Promise<{ conversationId: string; title: string }>
    isConversationBusy?(conversationId: string): boolean
    sendMessage(action: PluginRuntimeSendMessageAction): Promise<HapiCallbackEvent[] | void>
    sendMessageReserved(action: PluginRuntimeSendMessageAction): Promise<HapiCallbackEvent[] | void>
    approve(action: PluginRuntimeApproveAction): Promise<HapiCallbackEvent[] | void>
    deny(action: PluginRuntimeDenyAction): Promise<HapiCallbackEvent[] | void>
}
