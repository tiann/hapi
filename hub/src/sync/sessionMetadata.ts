import { CODEX_DESKTOP_SYNC_SOURCE, getExecutionControl, isObject } from '@hapi/protocol'
import type { ExecutionControl } from '@hapi/protocol/types'

function isMirrorSource(value: unknown): value is string {
    return value === CODEX_DESKTOP_SYNC_SOURCE
}

function getSummaryUpdatedAt(summary: unknown): number | null {
    if (!isObject(summary) || typeof summary.updatedAt !== 'number') {
        return null
    }
    return summary.updatedAt
}

function clearStaleArchiveFieldsIfRunning(metadata: unknown | null): unknown | null {
    if (!isObject(metadata) || metadata.lifecycleState !== 'running') {
        return metadata
    }

    const cleaned: Record<string, unknown> = { ...metadata }
    delete cleaned.archivedBy
    delete cleaned.archiveReason
    return cleaned
}

export function pickPreferredExecutionControl(
    current: ExecutionControl | null,
    incoming: ExecutionControl | null
): ExecutionControl | null {
    if (!current) return incoming
    if (!incoming) return current

    if (current.generation !== incoming.generation) {
        return current.generation > incoming.generation ? current : incoming
    }

    if (current.owner !== incoming.owner) {
        return current.owner === 'hapi-runner' ? current : incoming
    }

    const currentLease = current.leaseExpiresAt ?? Number.NEGATIVE_INFINITY
    const incomingLease = incoming.leaseExpiresAt ?? Number.NEGATIVE_INFINITY
    if (currentLease !== incomingLease) {
        return currentLease > incomingLease ? current : incoming
    }

    if (current.updatedAt !== incoming.updatedAt) {
        return current.updatedAt > incoming.updatedAt ? current : incoming
    }

    return incoming
}

export function mergeSessionMetadata(
    currentMetadata: unknown | null,
    incomingMetadata: unknown | null
): unknown | null {
    if (!isObject(currentMetadata)) {
        return clearStaleArchiveFieldsIfRunning(incomingMetadata)
    }
    if (!isObject(incomingMetadata)) {
        return clearStaleArchiveFieldsIfRunning(currentMetadata)
    }

    const merged: Record<string, unknown> = {
        ...currentMetadata,
        ...incomingMetadata
    }

    const currentSummary = currentMetadata.summary
    const incomingSummary = incomingMetadata.summary
    const currentSummaryUpdatedAt = getSummaryUpdatedAt(currentSummary)
    const incomingSummaryUpdatedAt = getSummaryUpdatedAt(incomingSummary)
    if (currentSummaryUpdatedAt !== null || incomingSummaryUpdatedAt !== null) {
        merged.summary = currentSummaryUpdatedAt !== null && (incomingSummaryUpdatedAt === null || currentSummaryUpdatedAt > incomingSummaryUpdatedAt)
            ? currentSummary
            : incomingSummary
    }

    if (isMirrorSource(currentMetadata.mirrorSource) || isMirrorSource(incomingMetadata.mirrorSource)) {
        merged.mirrorSource = CODEX_DESKTOP_SYNC_SOURCE
    }

    const preferredControl = pickPreferredExecutionControl(
        getExecutionControl(currentMetadata),
        getExecutionControl(incomingMetadata)
    )
    if (preferredControl) {
        merged.executionControl = preferredControl
    } else {
        delete merged.executionControl
    }

    return clearStaleArchiveFieldsIfRunning(merged)
}
