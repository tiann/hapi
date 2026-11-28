import { posix, win32 } from 'node:path'
import { getFlavorLabel, isKnownFlavor } from '@hapi/protocol'
import type { Session } from '../sync/syncEngine'

export function getSessionName(session: Session): string {
    if (session.metadata?.name) return session.metadata.name
    if (session.metadata?.summary?.text) return session.metadata.summary.text
    if (session.metadata?.path) {
        const { os, path } = session.metadata
        const isWindows = os === 'win32' || os === 'windows' || (!os && /^(?:[a-z]:|\\\\)/i.test(path))
        return (isWindows ? win32 : posix).basename(path) || session.id.slice(0, 8)
    }
    return session.id.slice(0, 8)
}

export function getAgentName(session: Session): string {
    const flavor = session.metadata?.flavor
    if (!flavor || !isKnownFlavor(flavor)) return 'Agent'
    return getFlavorLabel(flavor)
}

export function buildSessionUrl(baseUrl: string, sessionId: string): string {
    try {
        return new URL(`/sessions/${sessionId}`, baseUrl).toString()
    } catch {
        const normalized = baseUrl.replace(/\/+$/, '')
        return `${normalized}/sessions/${sessionId}`
    }
}
