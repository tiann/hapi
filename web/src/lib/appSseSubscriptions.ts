export type AppGlobalSseSubscription = {
    all: true
}

export type AppSessionSseSubscription = {
    sessionId: string
}

export function getAppGlobalSseSubscription(): AppGlobalSseSubscription {
    return { all: true }
}

export function getAppSessionSseSubscription(
    selectedSessionId: string | null | undefined
): AppSessionSseSubscription | null {
    if (!selectedSessionId) {
        return null
    }
    return { sessionId: selectedSessionId }
}
