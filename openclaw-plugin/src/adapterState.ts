const activeRuns = new Set<string>()

export const adapterState = {
    startRun(sessionKey: string): boolean {
        if (activeRuns.has(sessionKey)) {
            return false
        }

        activeRuns.add(sessionKey)
        return true
    },

    isRunActive(sessionKey: string): boolean {
        return activeRuns.has(sessionKey)
    },

    finishRun(sessionKey: string): boolean {
        return activeRuns.delete(sessionKey)
    },

    resetForTests(): void {
        activeRuns.clear()
    }
}
