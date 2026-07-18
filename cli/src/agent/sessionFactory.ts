import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

import { ApiClient } from '@/api/api'
import type { ApiSessionClient } from '@/api/apiSession'
import type { AgentState, MachineMetadata, Metadata, Session } from '@/api/types'
import type { ProviderReadinessMap } from '@hapi/protocol/types'
import { ProviderReadinessMapSchema } from '@hapi/protocol/schemas'
import { notifyRunnerSessionStarted } from '@/runner/controlClient'
import { readSettings } from '@/persistence'
import { configuration } from '@/configuration'
import { logger } from '@/ui/logger'
import { runtimePath } from '@/projectPath'
import { getInvokedCwd } from '@/utils/invokedCwd'
import { readWorktreeEnv } from '@/utils/worktreeEnv'
import packageJson from '../../package.json'

export type SessionStartedBy = 'runner' | 'terminal'

export type SessionBootstrapOptions = {
    flavor: string
    startedBy?: SessionStartedBy
    workingDirectory?: string
    tag?: string
    agentState?: AgentState | null
    model?: string
    modelReasoningEffort?: string
    serviceTier?: string
    effort?: string
    metadataOverrides?: Partial<Metadata>
}

export type SessionBootstrapResult = {
    api: ApiClient
    session: ApiSessionClient
    sessionInfo: Session
    metadata: Metadata
    machineId: string
    startedBy: SessionStartedBy
    workingDirectory: string
    reportStartedToRunner: () => Promise<void>
}

function mergeProviderReadiness(
    current: ProviderReadinessMap | undefined,
    incoming: ProviderReadinessMap,
): ProviderReadinessMap {
    const merged: ProviderReadinessMap = { ...(current ?? {}) }
    for (const [flavor, entry] of Object.entries(incoming)) {
        if (!entry) continue
        const existing = merged[flavor as keyof ProviderReadinessMap]
        if (!existing || entry.checkedAt > existing.checkedAt) {
            merged[flavor as keyof ProviderReadinessMap] = entry
        }
    }
    return ProviderReadinessMapSchema.parse(merged)
}

export function buildMachineMetadata(
    providerReadiness?: ProviderReadinessMap,
    current?: MachineMetadata | null,
    options: { replaceProviderReadiness?: boolean } = {},
): MachineMetadata {
    const parsedReadiness = providerReadiness
        ? ProviderReadinessMapSchema.parse(providerReadiness)
        : undefined
    return {
        host: process.env.HAPI_HOSTNAME || os.hostname(),
        platform: os.platform(),
        happyCliVersion: packageJson.version,
        ...(current?.displayName !== undefined ? { displayName: current.displayName } : {}),
        homeDir: os.homedir(),
        happyHomeDir: configuration.happyHomeDir,
        happyLibDir: runtimePath(),
        ...(parsedReadiness
            ? {
                providerReadiness: options.replaceProviderReadiness
                    ? parsedReadiness
                    : mergeProviderReadiness(current?.providerReadiness, parsedReadiness)
            }
            : {})
    }
}

export function buildSessionMetadata(options: {
    flavor: string
    startedBy: SessionStartedBy
    workingDirectory: string
    machineId: string
    now?: number
    metadataOverrides?: Partial<Metadata>
}): Metadata {
    const happyLibDir = runtimePath()
    const worktreeInfo = readWorktreeEnv()
    const now = options.now ?? Date.now()

    return {
        path: options.workingDirectory,
        host: process.env.HAPI_HOSTNAME || os.hostname(),
        version: packageJson.version,
        os: os.platform(),
        machineId: options.machineId,
        homeDir: os.homedir(),
        happyHomeDir: configuration.happyHomeDir,
        happyLibDir,
        happyToolsDir: resolve(happyLibDir, 'tools', 'unpacked'),
        startedFromRunner: options.startedBy === 'runner',
        hostPid: process.pid,
        startedBy: options.startedBy,
        lifecycleState: 'running',
        lifecycleStateSince: now,
        flavor: options.flavor,
        worktree: worktreeInfo ?? undefined,
        ...options.metadataOverrides
    }
}

async function getMachineIdOrExit(): Promise<string> {
    const settings = await readSettings()
    const machineId = settings?.machineId
    if (!machineId) {
        console.error(`[START] No machine ID found in settings, which is unexpected since authAndSetupMachineIfNeeded should have created it. Please report this issue on ${packageJson.bugs}`)
        process.exit(1)
    }
    logger.debug(`Using machineId: ${machineId}`)
    return machineId
}

type RunnerSessionStartedDelivery = {
    reported: boolean
    attempts: number
    error?: Error
}

// Keep an exact managed child alive long enough for a verified successor
// Runner to acquire ownership, reconnect to the Hub, adopt the child, and
// durably acknowledge the same webhook. The near-60-second delay window also
// covers serialized journal and spawn-store settlement during a controlled
// concurrent launch on slower filesystems. The sequence remains bounded so a
// permanently unavailable Runner cannot hang provider startup indefinitely.
const MANAGED_RUNNER_REPORT_RETRY_DELAYS_MS = [
    50, 100, 250, 500, 1_000, 2_000, 4_000,
    5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000
] as const
const MANAGED_RUNNER_REPORT_DEADLINE_MS = 60_000

function asDeliveryError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value))
}

export async function deliverSessionStartedToRunner(options: {
    sessionId: string
    metadata: Metadata
    notify?: typeof notifyRunnerSessionStarted
    sleep?: (delayMs: number) => Promise<void>
    retryDelaysMs?: readonly number[]
    now?: () => number
    deadlineMs?: number
}): Promise<RunnerSessionStartedDelivery> {
    const notify = options.notify ?? notifyRunnerSessionStarted
    const sleep = options.sleep ?? (async (delayMs: number) => {
        await new Promise((resolve) => setTimeout(resolve, delayMs))
    })
    const managed = typeof options.metadata.launchNonce === 'string'
        && options.metadata.launchNonce.length > 0
        && typeof options.metadata.runnerInstanceId === 'string'
        && options.metadata.runnerInstanceId.length > 0
    const retryDelays = managed
        ? (options.retryDelaysMs ?? MANAGED_RUNNER_REPORT_RETRY_DELAYS_MS)
        : []
    const maxAttempts = retryDelays.length + 1
    const now = options.now ?? Date.now
    const deadline = managed
        ? now() + Math.max(1, options.deadlineMs ?? MANAGED_RUNNER_REPORT_DEADLINE_MS)
        : null
    let lastError: Error | undefined
    let attempts = 0

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const remainingBeforeAttempt = deadline === null ? null : deadline - now()
        if (remainingBeforeAttempt !== null && remainingBeforeAttempt <= 0) break
        attempts = attempt
        try {
            const result = await notify(
                options.sessionId,
                options.metadata,
                remainingBeforeAttempt === null ? undefined : remainingBeforeAttempt
            )
            if (!result?.error) return { reported: true, attempts: attempt }
            lastError = asDeliveryError(result.error)
        } catch (error) {
            lastError = asDeliveryError(error)
        }

        if (attempt < maxAttempts) {
            const retryDelay = retryDelays[attempt - 1]!
            const remainingBeforeSleep = deadline === null ? null : deadline - now()
            if (remainingBeforeSleep !== null && remainingBeforeSleep <= 0) break
            await sleep(remainingBeforeSleep === null
                ? retryDelay
                : Math.min(retryDelay, remainingBeforeSleep))
        }
    }

    if (managed) {
        throw new Error(
            `Failed to report managed session ${options.sessionId} to Runner after ${attempts} attempts: ${lastError?.message ?? 'unknown error'}`
        )
    }
    return { reported: false, attempts, ...(lastError ? { error: lastError } : {}) }
}

async function reportSessionStarted(sessionId: string, metadata: Metadata): Promise<void> {
    logger.debug(`[START] Reporting session ${sessionId} to runner`)
    try {
        const result = await deliverSessionStartedToRunner({ sessionId, metadata })
        if (result.reported) {
            logger.debug(`[START] Reported session ${sessionId} to runner after ${result.attempts} attempt(s)`)
        } else {
            logger.debug(`[START] Failed to report to runner (may not be running):`, result.error)
        }
    } catch (error) {
        logger.debug('[START] Failed to report managed session to runner:', error)
        throw error
    }
}

export async function bootstrapSession(options: SessionBootstrapOptions): Promise<SessionBootstrapResult> {
    const workingDirectory = options.workingDirectory ?? getInvokedCwd()
    const startedBy = options.startedBy ?? 'terminal'
    const sessionTag = options.tag ?? randomUUID()
    const agentState = options.agentState === undefined ? {} : options.agentState

    const api = await ApiClient.create()

    const machineId = await getMachineIdOrExit()
    await api.getOrCreateMachine({
        machineId,
        metadata: buildMachineMetadata()
    })

    const launchNonce = process.env.HAPI_LAUNCH_NONCE
    const runnerInstanceId = process.env.HAPI_RUNNER_INSTANCE_ID
    const managedOverrides = launchNonce && runnerInstanceId ? { launchNonce, runnerInstanceId } : {}
    const metadata = buildSessionMetadata({
        flavor: options.flavor,
        startedBy,
        workingDirectory,
        machineId,
        metadataOverrides: { ...managedOverrides, ...options.metadataOverrides }
    })

    const sessionInfo = await api.getOrCreateSession({
        tag: sessionTag,
        metadata,
        state: agentState,
        model: options.model,
        modelReasoningEffort: options.modelReasoningEffort,
        serviceTier: options.serviceTier,
        effort: options.effort
    })

    const session = api.sessionSyncClient(sessionInfo)

    let runnerReport: Promise<void> | null = null
    const reportStartedToRunner = () => {
        runnerReport ??= reportSessionStarted(sessionInfo.id, metadata)
        return runnerReport
    }

    return {
        api,
        session,
        sessionInfo,
        metadata,
        machineId,
        startedBy,
        workingDirectory,
        reportStartedToRunner
    }
}
