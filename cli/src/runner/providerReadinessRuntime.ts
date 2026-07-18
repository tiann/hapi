import {
    getProviderSelectionIssue,
    type AgentFlavor,
    type ProviderReadiness,
    type ProviderReadinessIssueCode,
    type ProviderReadinessMap,
    type ProviderSelection,
} from '@hapi/protocol'
import { buildMachineMetadata } from '@/agent/sessionFactory'
import type { MachineMetadata } from '@/api/types'

export type ProviderReadinessSource = {
    probe: (flavor: AgentFlavor) => Promise<ProviderReadiness>
    snapshot: () => ProviderReadinessMap
    refreshDue: () => Promise<{ changed: boolean; snapshot: ProviderReadinessMap }>
}

export type ProviderReadinessPublisher = (snapshot: ProviderReadinessMap) => Promise<void>

export type ProviderReadinessMachineChannel = {
    connect: () => void
    waitForConnected: (timeoutMs: number) => Promise<boolean>
    onConnected?: (handler: () => void | Promise<void>) => () => void
    updateMachineMetadata: (
        handler: (metadata: MachineMetadata | null) => MachineMetadata
    ) => Promise<void>
}

export type ProviderSpawnReadinessError = {
    type: 'error'
    errorMessage: string
    code: ProviderReadinessIssueCode
    recoveryCommand?: string
}

function publishBestEffort(
    publish: ProviderReadinessPublisher | undefined,
    snapshot: ProviderReadinessMap,
): void {
    if (!publish) return
    try {
        void publish(snapshot).catch(() => undefined)
    } catch {
        // Readiness remains authoritative even when its best-effort metadata
        // publication cannot complete during this spawn attempt.
    }
}

export async function runWithProviderSpawnReadiness<T>(
    input: {
        flavor: AgentFlavor
        selection: ProviderSelection
        source: ProviderReadinessSource
        publish?: ProviderReadinessPublisher
        now?: number
    },
    onReady: () => Promise<T>,
): Promise<T | ProviderSpawnReadinessError> {
    try {
        await input.source.probe(input.flavor)
    } catch {
        return {
            type: 'error',
            code: 'provider-probe-failed',
            errorMessage: `${input.flavor} readiness could not be checked.`,
        }
    }

    const snapshot = input.source.snapshot()
    publishBestEffort(input.publish, snapshot)
    const issue = getProviderSelectionIssue(
        snapshot,
        input.flavor,
        input.selection,
        input.now ?? Date.now(),
    )
    if (issue) {
        return {
            type: 'error',
            code: issue.code,
            errorMessage: issue.recoveryCommand
                ? `${issue.message} Run: ${issue.recoveryCommand}`
                : issue.message,
            ...(issue.recoveryCommand ? { recoveryCommand: issue.recoveryCommand } : {}),
        }
    }

    return await onReady()
}

export function createProviderReadinessPublisher(
    source: ProviderReadinessSource,
    publishSnapshot: ProviderReadinessPublisher,
): {
    publish: ProviderReadinessPublisher
    refreshAndPublish: () => Promise<boolean>
} {
    let publicationDirty = false
    let publicationGeneration = 0

    const publish: ProviderReadinessPublisher = async (snapshot) => {
        publicationDirty = true
        const generation = ++publicationGeneration
        await publishSnapshot(snapshot)
        if (generation === publicationGeneration) publicationDirty = false
    }

    const refreshAndPublish = async () => {
        const refreshed = await source.refreshDue()
        publicationDirty ||= refreshed.changed
        if (!publicationDirty) return false

        await publish(source.snapshot())
        return true
    }

    return { publish, refreshAndPublish }
}

export async function connectAndPublishProviderReadiness(
    channel: ProviderReadinessMachineChannel,
    source: ProviderReadinessSource,
    timeoutMs: number,
    publish?: ProviderReadinessPublisher,
): Promise<true> {
    let initialPublished = false
    const publishSnapshot = publish ?? (async (snapshot: ProviderReadinessMap) => {
        await channel.updateMachineMetadata((current) => buildMachineMetadata(snapshot, current))
    })
    channel.onConnected?.(async () => {
        if (!initialPublished) return
        try {
            const refreshed = await source.refreshDue()
            await publishSnapshot(refreshed.snapshot)
        } catch {
            // Reconnect publication is best effort; the next reconnect or
            // heartbeat retries with the authoritative local snapshot.
        }
    })
    channel.connect()
    if (!await channel.waitForConnected(timeoutMs)) {
        throw new Error('Runner could not establish the managed hub outcome path during startup')
    }
    await channel.updateMachineMetadata((current) => buildMachineMetadata(
        source.snapshot(),
        current,
        { replaceProviderReadiness: true },
    ))
    initialPublished = true
    return true
}
