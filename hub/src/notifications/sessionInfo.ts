import { getFlavorLabel, getSessionDisplayTitle, isKnownFlavor } from '@hapi/protocol'
import type { Session } from '../sync/syncEngine'

export function getSessionName(session: Session): string {
    return getSessionDisplayTitle(session)
}

export function getAgentName(session: Session): string {
    const flavor = session.metadata?.flavor
    if (!flavor || !isKnownFlavor(flavor)) return 'Agent'
    return getFlavorLabel(flavor)
}
