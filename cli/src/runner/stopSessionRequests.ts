export type StopSessionOptions = {
    processStartMarker?: string
    /**
     * The hub stops a wrapper it could not reach. Ask the hub right before
     * signalling, for every flavor, so a wrapper that reconnected is kept.
     */
    confirmUnreachable?: boolean
}

/** A late RPC retry joins the original stop instead of racing its tree signals. */
export function coalesceStopRequests<T>(stop: (id: string, opts?: StopSessionOptions) => Promise<T>) {
    const pending = new Map<string, Promise<T>>()
    return async (id: string, opts?: StopSessionOptions): Promise<T> => {
        // Raw PID calls from different generations must never share evidence,
        // and an explicit stop must never inherit a recovery stop's refusal.
        const key = JSON.stringify([id, opts?.processStartMarker ?? null, opts?.confirmUnreachable === true])
        const existing = pending.get(key)
        if (existing) return existing
        const operation = stop(id, opts)
        pending.set(key, operation)
        try { return await operation } finally {
            if (pending.get(key) === operation) pending.delete(key)
        }
    }
}
