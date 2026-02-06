export type SSEEventContract = {
    type: string
    fields: Record<string, { type: string; optional: boolean }>
}

export const sseContracts: SSEEventContract[] = [
    {
        type: 'session-added',
        fields: {
            namespace: { type: 'string', optional: true },
            sessionId: { type: 'string', optional: false },
            data: { type: 'object', optional: true }
        }
    },
    {
        type: 'session-updated',
        fields: {
            namespace: { type: 'string', optional: true },
            sessionId: { type: 'string', optional: false },
            data: { type: 'object', optional: true }
        }
    },
    {
        type: 'session-removed',
        fields: {
            namespace: { type: 'string', optional: true },
            sessionId: { type: 'string', optional: false }
        }
    },
    {
        type: 'message-received',
        fields: {
            namespace: { type: 'string', optional: true },
            sessionId: { type: 'string', optional: false },
            message: { type: 'object', optional: false }
        }
    },
    {
        type: 'machine-updated',
        fields: {
            namespace: { type: 'string', optional: true },
            machineId: { type: 'string', optional: false },
            data: { type: 'object', optional: true }
        }
    },
    {
        type: 'toast',
        fields: {
            namespace: { type: 'string', optional: true },
            data: { type: 'object', optional: false }
        }
    },
    {
        type: 'connection-changed',
        fields: {
            namespace: { type: 'string', optional: true },
            data: { type: 'object', optional: true }
        }
    }
]
