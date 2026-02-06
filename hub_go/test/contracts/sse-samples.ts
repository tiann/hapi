export type SSESample = {
    type: string
    [key: string]: unknown
}

// Synthetic samples derived from source behavior for event types not recorded at runtime.
export const sseSamples: SSESample[] = [
    {
        type: 'message-received',
        namespace: 'default',
        sessionId: 'example-session-id',
        message: {
            id: 'example-message-id',
            seq: 1,
            localId: 'local-1',
            content: { role: 'user', content: 'hello' },
            createdAt: 1700000000000
        }
    },
    {
        type: 'machine-updated',
        namespace: 'default',
        machineId: 'example-machine-id',
        data: { id: 'example-machine-id' }
    },
    {
        type: 'session-added',
        namespace: 'default',
        sessionId: 'example-session-id',
        data: { id: 'example-session-id' }
    },
    {
        type: 'session-removed',
        namespace: 'default',
        sessionId: 'example-session-id'
    },
    {
        type: 'toast',
        namespace: 'default',
        data: {
            title: 'Example Title',
            body: 'Example Body',
            sessionId: 'example-session-id',
            url: 'https://example.invalid'
        }
    }
]
