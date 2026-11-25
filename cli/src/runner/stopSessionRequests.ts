export type StopSessionOptions = {
    processStartMarker?: string
    /**
     * The hub asks to stop exactly this wrapper process because it cannot
     * reach it. Nothing else is signalled, and the hub confirms right before.
     */
    recovery?: { requestId: string; pid: number }
}

/** A late RPC retry joins the original stop instead of racing its tree signals. */
export function coalesceStopRequests<T>(stop: (id: string, opts?: StopSessionOptions) => Promise<T>) {
    const pending = new Map<string, Promise<T>>()
    return async (id: string, opts?: StopSessionOptions): Promise<T> => {
        // Raw PID calls from different generations must never share evidence,
        // and an explicit stop must never join a recovery stop.
        const key = JSON.stringify([id, opts?.processStartMarker ?? null, opts?.recovery?.requestId ?? null])
        const existing = pending.get(key)
        if (existing) return existing
        const operation = stop(id, opts)
        pending.set(key, operation)
        try { return await operation } finally {
            if (pending.get(key) === operation) pending.delete(key)
        }
    }
}
