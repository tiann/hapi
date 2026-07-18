export async function establishCursorNativeIdentity(options: {
    runBootstrap(onNativeIdentity: (sessionId: string) => void): Promise<number | null>
    acknowledge(sessionId: string): Promise<void>
}): Promise<string> {
    let observedSessionId: string | null = null
    let conflictingIdentity = false
    const exitCode = await options.runBootstrap((sessionId) => {
        if (observedSessionId && observedSessionId !== sessionId) conflictingIdentity = true
        observedSessionId = sessionId
    })
    if (exitCode !== 0) {
        throw new Error(`Cursor identity bootstrap exited with code ${exitCode ?? 'null'}`)
    }
    if (!observedSessionId || conflictingIdentity) {
        throw new Error('Cursor identity bootstrap did not produce one stable native session id')
    }
    await options.acknowledge(observedSessionId)
    return observedSessionId
}

export function createCursorNativeIdentityTracker(options: {
    initialSessionId: string
    acknowledge(sessionId: string): Promise<void>
    onRejected(error: unknown): void
}): {
    observe(sessionId: string): void
    settle(): Promise<void>
    currentSessionId(): string
} {
    let currentSessionId = options.initialSessionId
    let rejection: { error: unknown } | null = null
    let barrier = Promise.resolve()

    const observe = (sessionId: string) => {
        barrier = barrier.then(async () => {
            if (rejection || sessionId === currentSessionId) return
            await options.acknowledge(sessionId)
            currentSessionId = sessionId
        }).catch((error) => {
            if (!rejection) {
                rejection = { error }
                options.onRejected(error)
            }
        })
    }

    return {
        observe,
        settle: async () => {
            await barrier
            if (rejection) throw rejection.error
        },
        currentSessionId: () => currentSessionId
    }
}
