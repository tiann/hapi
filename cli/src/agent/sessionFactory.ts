import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

import { ApiClient } from '@/api/api'
import type { ApiSessionClient } from '@/api/apiSession'
import type { AgentState, MachineMetadata, Metadata, Session } from '@/api/types'
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
}

export function buildMachineMetadata(options?: { workspaceRoots?: string[] }): MachineMetadata {
    return {
        host: process.env.HAPI_HOSTNAME || os.hostname(),
        platform: os.platform(),
        happyCliVersion: packageJson.version,
        homeDir: os.homedir(),
        happyHomeDir: configuration.happyHomeDir,
        happyLibDir: runtimePath(),
        workspaceRoots: options?.workspaceRoots
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
        capabilities: {
            terminal: true
        },
        worktree: worktreeInfo ?? undefined,
        ...options.metadataOverrides
    }
}

function pickExistingSessionMetadata(metadata: Metadata | null | undefined): Partial<Metadata> {
    if (!metadata) return {}

    const preserved: Partial<Metadata> = {}

    if (metadata.name !== undefined) preserved.name = metadata.name
    if (metadata.summary !== undefined) preserved.summary = metadata.summary
    if (metadata.claudeSessionId !== undefined) preserved.claudeSessionId = metadata.claudeSessionId
    if (metadata.codexSessionId !== undefined) preserved.codexSessionId = metadata.codexSessionId
    if (metadata.codexSourceSessionId !== undefined) preserved.codexSourceSessionId = metadata.codexSourceSessionId
    if (metadata.geminiSessionId !== undefined) preserved.geminiSessionId = metadata.geminiSessionId
    if (metadata.opencodeSessionId !== undefined) preserved.opencodeSessionId = metadata.opencodeSessionId
    if (metadata.grokSessionId !== undefined) preserved.grokSessionId = metadata.grokSessionId
    if (metadata.cursorSessionId !== undefined) preserved.cursorSessionId = metadata.cursorSessionId
    if (metadata.cursorSessionProtocol !== undefined) preserved.cursorSessionProtocol = metadata.cursorSessionProtocol
    if (metadata.kimiSessionId !== undefined) preserved.kimiSessionId = metadata.kimiSessionId
    if (metadata.piSessionId !== undefined) preserved.piSessionId = metadata.piSessionId
    if (metadata.preferredPermissionMode !== undefined) preserved.preferredPermissionMode = metadata.preferredPermissionMode
    if (metadata.tools !== undefined) preserved.tools = metadata.tools
    if (metadata.slashCommands !== undefined) preserved.slashCommands = metadata.slashCommands
    if (metadata.worktree !== undefined) preserved.worktree = metadata.worktree
    // Preserve cached Pi model list so the web can show models immediately
    // on inactive-session view without waiting for an RPC round-trip.
    if (metadata.piAvailableModels !== undefined) preserved.piAvailableModels = metadata.piAvailableModels
    // Preserve provider-qualified Pi model selection (disambiguates duplicate modelIds).
    if (metadata.piSelectedModel !== undefined) preserved.piSelectedModel = metadata.piSelectedModel

    return preserved
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

async function reportSessionStarted(sessionId: string, metadata: Metadata): Promise<void> {
    try {
        logger.debug(`[START] Reporting session ${sessionId} to runner`)
        const result = await notifyRunnerSessionStarted(sessionId, metadata)
        if (result?.error) {
            logger.debug(`[START] Failed to report to runner (may not be running):`, result.error)
        } else {
            logger.debug(`[START] Reported session ${sessionId} to runner`)
        }
    } catch (error) {
        logger.debug('[START] Failed to report to runner (may not be running):', error)
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

    const metadata = buildSessionMetadata({
        flavor: options.flavor,
        startedBy,
        workingDirectory,
        machineId,
        metadataOverrides: options.metadataOverrides
    })

    const sessionInfo = await api.getOrCreateSession({
        tag: sessionTag,
        metadata,
        state: agentState,
        model: options.model,
        modelReasoningEffort: options.modelReasoningEffort,
        effort: options.effort
    })

    const session = api.sessionSyncClient(sessionInfo)

    await reportSessionStarted(sessionInfo.id, metadata)

    return {
        api,
        session,
        sessionInfo,
        metadata,
        machineId,
        startedBy,
        workingDirectory
    }
}

export async function bootstrapLazySession(options: SessionBootstrapOptions): Promise<SessionBootstrapResult> {
    const workingDirectory = options.workingDirectory ?? getInvokedCwd()
    const startedBy = options.startedBy ?? 'terminal'
    if (startedBy !== 'terminal') {
        throw new Error('Lazy session bootstrap is only supported for terminal sessions')
    }

    const api = await ApiClient.create()
    const machineId = await getMachineIdOrExit()
    const machineMetadata = buildMachineMetadata()
    const metadata = buildSessionMetadata({
        flavor: options.flavor,
        startedBy,
        workingDirectory,
        machineId,
        metadataOverrides: options.metadataOverrides
    })
    const agentState = options.agentState === undefined ? {} : options.agentState
    const now = Date.now()
    const requestedId = randomUUID()
    const sessionTag = options.tag ?? randomUUID()
    const sessionInfo: Session = {
        id: requestedId,
        namespace: 'pending',
        seq: 0,
        createdAt: now,
        updatedAt: now,
        active: false,
        activeAt: now,
        metadata,
        metadataVersion: 0,
        agentState,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: now,
        todos: [],
        model: options.model ?? null,
        modelReasoningEffort: options.modelReasoningEffort ?? null,
        effort: options.effort ?? null,
        serviceTier: null,
        permissionMode: undefined,
        collaborationMode: undefined
    }

    const session = api.sessionSyncClient(sessionInfo, {
        materialize: async (snapshot, signal) => {
            const materialized = await api.getOrCreateSession({
                id: requestedId,
                tag: sessionTag,
                metadata: snapshot.metadata ?? metadata,
                state: snapshot.agentState,
                model: options.model,
                modelReasoningEffort: options.modelReasoningEffort,
                effort: options.effort,
                machine: {
                    id: machineId,
                    metadata: machineMetadata
                },
                timeoutMs: 10_000,
                signal
            })
            if (materialized.id !== requestedId) {
                throw new Error(`Hub returned unexpected session id ${materialized.id}`)
            }
            return materialized
        },
        onMaterialized: (materialized, snapshot) => {
            void reportSessionStarted(materialized.id, snapshot.metadata ?? metadata)
        }
    })

    return {
        api,
        session,
        sessionInfo,
        metadata,
        machineId,
        startedBy,
        workingDirectory
    }
}

export async function bootstrapExistingSession(options: {
    sessionId: string
    flavor: string
    startedBy?: SessionStartedBy
    workingDirectory: string
    metadataOverrides?: Partial<Metadata>
}): Promise<SessionBootstrapResult> {
    const startedBy = options.startedBy ?? 'terminal'
    const api = await ApiClient.create()
    const machineId = await getMachineIdOrExit()

    await api.getOrCreateMachine({
        machineId,
        metadata: buildMachineMetadata()
    })

    const sessionInfo = await api.getSession(options.sessionId)
    const baseMetadata = buildSessionMetadata({
        flavor: options.flavor,
        startedBy,
        workingDirectory: options.workingDirectory,
        machineId
    })
    const metadata = {
        ...baseMetadata,
        ...pickExistingSessionMetadata(sessionInfo.metadata),
        ...options.metadataOverrides
    }

    const buildUpdatedMetadata = (current: Metadata): Metadata => ({
        ...baseMetadata,
        ...pickExistingSessionMetadata(current),
        ...options.metadataOverrides
    })

    const session = api.sessionSyncClient(sessionInfo)
    session.updateMetadata(buildUpdatedMetadata)
    await reportSessionStarted(sessionInfo.id, metadata)

    return {
        api,
        session,
        sessionInfo,
        metadata,
        machineId,
        startedBy,
        workingDirectory: options.workingDirectory
    }
}
