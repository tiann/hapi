export type PeerDeliveryInfo = {
    sourceSessionId?: string
    sourceName?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
}

/** True when message meta marks peer/CLI delivery (#1203). */
export function isPeerDeliveryMeta(meta: unknown): boolean {
    if (!isRecord(meta)) return false
    return meta.sentFrom === 'peer'
}

export function getPeerDeliveryInfo(meta: unknown): PeerDeliveryInfo | null {
    if (!isPeerDeliveryMeta(meta) || !isRecord(meta)) return null
    const peer = isRecord(meta.peer) ? meta.peer : null
    const sourceSessionId = typeof peer?.sourceSessionId === 'string' && peer.sourceSessionId.trim()
        ? peer.sourceSessionId.trim()
        : undefined
    const sourceName = typeof peer?.sourceName === 'string' && peer.sourceName.trim()
        ? peer.sourceName.trim()
        : undefined
    return { sourceSessionId, sourceName }
}
