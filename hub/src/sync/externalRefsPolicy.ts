/**
 * Policy helpers for metadata.externalRefs under githubPrAwareness.
 */

import { ExternalRefsSchema } from '@hapi/protocol/schemas'

export function stripExternalRefsWhenAwarenessDisabled(metadata: unknown, awarenessEnabled: boolean): unknown {
    if (awarenessEnabled) {
        return metadata
    }
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        return metadata
    }
    if (!('externalRefs' in metadata)) {
        return metadata
    }
    const next = { ...(metadata as Record<string, unknown>) }
    delete next.externalRefs
    return next
}

export function externalRefsInMetadataValid(metadata: unknown): boolean {
    if (!metadata || typeof metadata !== 'object') {
        return true
    }
    const refs = (metadata as Record<string, unknown>).externalRefs
    if (refs === undefined) {
        return true
    }
    return ExternalRefsSchema.safeParse(refs).success
}
