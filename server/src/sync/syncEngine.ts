/**
 * Sync Engine for HAPI Telegram Bot (Direct Connect)
 *
 * In the direct-connect architecture:
 * - hapi-server is the server (Socket.IO + REST)
 * - hapi CLI connects directly to the server (no relay)
 * - No E2E encryption; data is stored as JSON in SQLite
 */

import type { DecryptedMessage, ModelMode, PermissionMode, Session, SyncEvent } from '@hapi/protocol/types'
import type { Server } from 'socket.io'
import { randomUUID } from 'node:crypto'
import type { Store } from '../store'
import type { RpcRegistry } from '../socket/rpcRegistry'
import type { SSEManager } from '../sse/sseManager'
import { EventPublisher, type SyncEventListener } from './eventPublisher'
import { MachineCache, type Machine } from './machineCache'
import { MessageService } from './messageService'
import { RpcGateway, type RpcCommandResponse, type RpcPathExistsResponse, type RpcReadFileResponse, type RpcUploadFileResponse, type RpcDeleteUploadResponse } from './rpcGateway'
import { SessionCache } from './sessionCache'

export type { Session, SyncEvent } from '@hapi/protocol/types'
export type { Machine } from './machineCache'
export type { SyncEventListener } from './eventPublisher'
export type { RpcCommandResponse, RpcPathExistsResponse, RpcReadFileResponse, RpcUploadFileResponse, RpcDeleteUploadResponse } from './rpcGateway'

export class SyncEngine {
    private readonly eventPublisher: EventPublisher
    private readonly sessionCache: SessionCache
    private readonly machineCache: MachineCache
    private readonly messageService: MessageService
    private readonly rpcGateway: RpcGateway
    private readonly store: Store
    private inactivityTimer: NodeJS.Timeout | null = null
    private readonly resumeLocks = new Map<string, Promise<void>>()

    constructor(
        store: Store,
        io: Server,
        rpcRegistry: RpcRegistry,
        sseManager: SSEManager
    ) {
        this.store = store
        this.eventPublisher = new EventPublisher(sseManager, (event) => this.resolveNamespace(event))
        this.sessionCache = new SessionCache(store, this.eventPublisher)
        this.machineCache = new MachineCache(store, this.eventPublisher)
        this.messageService = new MessageService(store, io, this.eventPublisher)
        this.rpcGateway = new RpcGateway(io, rpcRegistry)
        this.reloadAll()
        this.inactivityTimer = setInterval(() => this.expireInactive(), 5_000)
    }

    stop(): void {
        if (this.inactivityTimer) {
            clearInterval(this.inactivityTimer)
            this.inactivityTimer = null
        }
    }

    subscribe(listener: SyncEventListener): () => void {
        return this.eventPublisher.subscribe(listener)
    }

    private resolveNamespace(event: SyncEvent): string | undefined {
        if (event.namespace) {
            return event.namespace
        }
        if ('sessionId' in event) {
            return this.sessionCache.getSession(event.sessionId)?.namespace
        }
        if ('machineId' in event) {
            return this.machineCache.getMachine(event.machineId)?.namespace
        }
        return undefined
    }

    getSessions(): Session[] {
        return this.sessionCache.getSessions()
    }

    getSessionsByNamespace(namespace: string): Session[] {
        return this.sessionCache.getSessionsByNamespace(namespace)
    }

    getSession(sessionId: string): Session | undefined {
        return this.sessionCache.getSession(sessionId)
    }

    getSessionByNamespace(sessionId: string, namespace: string): Session | undefined {
        return this.sessionCache.getSessionByNamespace(sessionId, namespace)
    }

    getActiveSessions(): Session[] {
        return this.sessionCache.getActiveSessions()
    }

    getMachines(): Machine[] {
        return this.machineCache.getMachines()
    }

    getMachinesByNamespace(namespace: string): Machine[] {
        return this.machineCache.getMachinesByNamespace(namespace)
    }

    getMachine(machineId: string): Machine | undefined {
        return this.machineCache.getMachine(machineId)
    }

    getMachineByNamespace(machineId: string, namespace: string): Machine | undefined {
        return this.machineCache.getMachineByNamespace(machineId, namespace)
    }

    getOnlineMachines(): Machine[] {
        return this.machineCache.getOnlineMachines()
    }

    getOnlineMachinesByNamespace(namespace: string): Machine[] {
        return this.machineCache.getOnlineMachinesByNamespace(namespace)
    }

    getMessagesPage(sessionId: string, options: { limit: number; beforeSeq: number | null }): {
        messages: DecryptedMessage[]
        page: {
            limit: number
            beforeSeq: number | null
            nextBeforeSeq: number | null
            hasMore: boolean
        }
    } {
        return this.messageService.getMessagesPage(sessionId, options)
    }

    getMessagesAfter(sessionId: string, options: { afterSeq: number; limit: number }): DecryptedMessage[] {
        return this.messageService.getMessagesAfter(sessionId, options)
    }

    handleRealtimeEvent(event: SyncEvent): void {
        if (event.type === 'session-updated' && event.sessionId) {
            this.sessionCache.refreshSession(event.sessionId)
            return
        }

        if (event.type === 'machine-updated' && event.machineId) {
            this.machineCache.refreshMachine(event.machineId)
            return
        }

        if (event.type === 'message-received' && event.sessionId) {
            if (!this.sessionCache.getSession(event.sessionId)) {
                this.sessionCache.refreshSession(event.sessionId)
            }
        }

        this.eventPublisher.emit(event)
    }

    handleSessionAlive(payload: {
        sid: string
        time: number
        thinking?: boolean
        mode?: 'local' | 'remote'
        permissionMode?: PermissionMode
        modelMode?: ModelMode
    }): void {
        this.sessionCache.handleSessionAlive(payload)
    }

    handleSessionEnd(payload: { sid: string; time: number }): void {
        this.sessionCache.handleSessionEnd(payload)
    }

    handleMachineAlive(payload: { machineId: string; time: number }): void {
        this.machineCache.handleMachineAlive(payload)
    }

    private expireInactive(): void {
        this.sessionCache.expireInactive()
        this.machineCache.expireInactive()
    }

    private reloadAll(): void {
        this.sessionCache.reloadAll()
        this.machineCache.reloadAll()
    }

    getOrCreateSession(id: string | null, metadata: unknown, agentState: unknown, namespace: string): Session {
        return this.sessionCache.getOrCreateSession(id, metadata, agentState, namespace)
    }

    getOrCreateMachine(id: string, metadata: unknown, runnerState: unknown, namespace: string): Machine {
        return this.machineCache.getOrCreateMachine(id, metadata, runnerState, namespace)
    }

    async sendMessage(
        sessionId: string,
        payload: {
            text: string
            localId?: string | null
            attachments?: Array<{
                id: string
                filename: string
                mimeType: string
                size: number
                path: string
                previewUrl?: string
            }>
            sentFrom?: 'telegram-bot' | 'webapp'
        }
    ): Promise<void> {
        await this.messageService.sendMessage(sessionId, payload)
    }

    async approvePermission(
        sessionId: string,
        requestId: string,
        mode?: PermissionMode,
        allowTools?: string[],
        decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort',
        answers?: Record<string, string[]> | Record<string, { answers: string[] }>
    ): Promise<void> {
        await this.rpcGateway.approvePermission(sessionId, requestId, mode, allowTools, decision, answers)
    }

    async denyPermission(
        sessionId: string,
        requestId: string,
        decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort'
    ): Promise<void> {
        await this.rpcGateway.denyPermission(sessionId, requestId, decision)
    }

    async abortSession(sessionId: string): Promise<void> {
        await this.rpcGateway.abortSession(sessionId)
    }

    async archiveSession(sessionId: string): Promise<void> {
        await this.rpcGateway.killSession(sessionId)
        this.handleSessionEnd({ sid: sessionId, time: Date.now() })
    }

    /**
     * Resume a session by either reconnecting to an existing CLI process or spawning a new one.
     *
     * This method implements concurrency control to prevent duplicate resume operations:
     * - If a resume is already in progress for this session, waits for it to complete
     * - If no resume is in progress, starts one and tracks it
     *
     * Two-phase resume strategy:
     * 1. Try RPC reconnection (if CLI process is still running)
     * 2. Fall back to spawning new process with --resume flag (if CLI exited)
     *
     * @param sessionId - The hapi session ID to resume
     * @throws {Error} If session not found, already active, or resume fails
     */
    async resumeSession(sessionId: string): Promise<void> {
        // Check if there's already a resume operation in progress for this session
        const existingResume = this.resumeLocks.get(sessionId)
        if (existingResume) {
            // Wait for the existing resume to complete
            return await existingResume
        }

        // Start a new resume operation
        const resumePromise = this.performResume(sessionId)
        this.resumeLocks.set(sessionId, resumePromise)

        try {
            return await resumePromise
        } finally {
            // Clean up the lock when done (success or failure)
            this.resumeLocks.delete(sessionId)
        }
    }

    /**
     * Retry a function with exponential backoff.
     *
     * @param fn - The async function to retry
     * @param options - Retry configuration
     * @returns The result of the function
     * @throws The last error if all retries fail
     */
    private async retryWithBackoff<T>(
        fn: () => Promise<T>,
        options: {
            attempts: number
            initialDelayMs: number
            maxDelayMs: number
            backoffMultiplier: number
            shouldRetry?: (error: unknown) => boolean
        }
    ): Promise<T> {
        const { attempts, initialDelayMs, maxDelayMs, backoffMultiplier, shouldRetry } = options
        let lastError: unknown

        for (let attempt = 1; attempt <= attempts; attempt++) {
            try {
                return await fn()
            } catch (error) {
                lastError = error

                // Check if we should retry this error
                if (shouldRetry && !shouldRetry(error)) {
                    throw error
                }

                // Don't retry on the last attempt
                if (attempt === attempts) {
                    throw error
                }

                // Calculate delay with exponential backoff
                const delay = Math.min(
                    initialDelayMs * Math.pow(backoffMultiplier, attempt - 1),
                    maxDelayMs
                )

                // Wait before retrying
                await new Promise(resolve => setTimeout(resolve, delay))
            }
        }

        throw lastError
    }

    /**
     * Internal implementation of session resume logic.
     * This is separated from resumeSession() to allow for proper lock management.
     */
    private async performResume(sessionId: string): Promise<void> {
        console.log('[SyncEngine.performResume] Starting resume:', { sessionId })

        const session = this.sessionCache.getSession(sessionId)
        if (!session) {
            console.log('[SyncEngine.performResume] Session not found:', { sessionId })
            throw new Error('Session not found')
        }
        if (session.active) {
            console.log('[SyncEngine.performResume] Session already active:', { sessionId })
            throw new Error('Session is already active')
        }

        console.log('[SyncEngine.performResume] Session state:', {
            sessionId,
            active: session.active,
            flavor: session.metadata?.flavor,
            hasClaudeSessionId: !!session.metadata?.claudeSessionId,
            hasCodexSessionId: !!session.metadata?.codexSessionId,
            hasGeminiSessionId: !!session.metadata?.geminiSessionId
        })

        // Capture the initial state for atomic transition check
        const initialActiveState = session.active

        // Try RPC resume first (if CLI still running) with retry logic
        try {
            console.log('[SyncEngine.performResume] Trying RPC resume first:', { sessionId })
            await this.retryWithBackoff(
                () => this.rpcGateway.resumeSession(sessionId),
                {
                    attempts: 3,
                    initialDelayMs: 1000,
                    maxDelayMs: 5000,
                    backoffMultiplier: 2,
                    shouldRetry: (error) => {
                        const message = error instanceof Error ? error.message : ''
                        // Only retry on timeout errors, not on "not registered" or "disconnected"
                        // Those errors mean the CLI is definitely gone
                        return message.includes('Timeout') || message.includes('timeout')
                    }
                }
            )
            // Success - CLI was still running, just reconnected
            console.log('[SyncEngine.performResume] RPC resume successful (CLI was still running):', { sessionId })
            return
        } catch (error) {
            const message = error instanceof Error ? error.message : ''
            console.log('[SyncEngine.performResume] RPC resume failed:', { sessionId, error: message })

            // If RPC failed because CLI is gone, spawn with --resume
            if (message.includes('RPC handler not registered') ||
                message.includes('RPC socket disconnected')) {
                console.log('[SyncEngine.performResume] CLI is gone, will spawn with --resume:', { sessionId })

                // Atomic state transition check: verify session hasn't become active
                // while we were attempting RPC reconnection
                const currentSession = this.sessionCache.getSession(sessionId)
                if (!currentSession) {
                    throw new Error('Session was deleted during resume attempt')
                }
                if (currentSession.active !== initialActiveState) {
                    throw new Error('Session state changed during resume - session may have already reconnected')
                }

                await this.spawnWithResume(currentSession)
                console.log('[SyncEngine.performResume] spawnWithResume completed:', { sessionId })
                return
            }

            // Other error - rethrow
            console.log('[SyncEngine.performResume] Rethrowing error:', { sessionId, error: message })
            throw error
        }
    }

    /**
     * Spawn a new CLI process with Claude's --resume flag to continue an existing session.
     *
     * **Session ID Duality Explained:**
     *
     * This system uses TWO different session IDs:
     *
     * 1. **Hapi Session ID** (`session.id`):
     *    - UUID generated by hapi server when session is created
     *    - Stored in database, shown in UI, used in URLs
     *    - STAYS CONSTANT across resume operations
     *    - This is what users see and interact with
     *
     * 2. **Claude Session ID** (`metadata.claudeSessionId`):
     *    - UUID generated by Claude CLI for its internal session management
     *    - Stored in `metadata.claudeSessionId` field
     *    - MAY CHANGE when using Claude's --resume flag
     *    - Used for accessing Claude's conversation history files
     *
     * **What Happens During Resume:**
     *
     * 1. User clicks "Resume" on hapi session `abc-123`
     * 2. This method spawns: `claude --resume old-claude-uuid`
     * 3. Claude creates a NEW session with ID `new-claude-uuid`
     * 4. Claude copies full conversation history from old session to new session
     * 5. New CLI process reports back via SessionStart hook with `new-claude-uuid`
     * 6. Server updates `metadata.claudeSessionId` to `new-claude-uuid`
     * 7. User continues in same hapi session `abc-123` (no redirect)
     *
     * **Important:** Multiple Claude sessions can map to one hapi session over time
     * as the user resumes repeatedly. The hapi session ID is the stable identifier.
     *
     * @param session - The hapi session to resume (contains both hapi ID and Claude ID)
     * @throws {Error} If session metadata is missing or invalid
     */
    private async spawnWithResume(session: Session): Promise<void> {
        console.log('[SyncEngine.spawnWithResume] Starting:', { sessionId: session.id })

        const metadata = session.metadata
        if (!metadata) {
            console.log('[SyncEngine.spawnWithResume] No metadata:', { sessionId: session.id })
            throw new Error('Session has no metadata')
        }

        const flavor = metadata.flavor || 'claude'
        let sessionIdToResume: string | undefined

        switch (flavor) {
            case 'claude':
                sessionIdToResume = metadata.claudeSessionId
                break
            case 'codex':
                sessionIdToResume = metadata.codexSessionId
                break
            case 'gemini':
                sessionIdToResume = metadata.geminiSessionId
                break
            default:
                throw new Error(`Unknown agent flavor: ${flavor}`)
        }

        if (!sessionIdToResume) {
            console.log('[SyncEngine.spawnWithResume] No session ID to resume:', {
                sessionId: session.id,
                flavor,
                metadata
            })
            throw new Error(
                `No ${flavor} session ID found - cannot resume. ` +
                `Session may not have been fully initialized.`
            )
        }

        const machineId = metadata.machineId
        if (!machineId) {
            console.log('[SyncEngine.spawnWithResume] No machine ID:', { sessionId: session.id })
            throw new Error('No machine ID found')
        }

        // Check if this is a fork operation
        const shouldFork = metadata.shouldFork === true
        const shouldEnableYolo = metadata.shouldEnableYolo === true

        console.log('[SyncEngine.spawnWithResume] Calling spawnResumedSession:', {
            hapiSessionId: session.id,
            machineId,
            path: metadata.path,
            sessionIdToResume,
            flavor,
            shouldFork,
            shouldEnableYolo
        })

        // Spawn new process with --resume (and optionally --fork-session and --yolo)
        // This will create a new CLI process that resumes the agent session
        // The spawned process will report back with a (potentially new) session ID
        // but will use the same hapi session ID
        await this.rpcGateway.spawnResumedSession(
            session.id,           // Hapi session ID (reuse existing - stays constant)
            machineId,
            metadata.path,
            sessionIdToResume,    // Agent session ID to resume from (may change after resume)
            flavor,
            shouldFork,           // Pass fork flag
            shouldEnableYolo      // Pass yolo flag
        )

        // Clear flags and update YOLO state after spawning
        if (shouldFork || shouldEnableYolo) {
            const updatedMetadata = {
                ...session.metadata,
                shouldFork: false,
                shouldEnableYolo: false,
                yolo: shouldEnableYolo ? true : session.metadata?.yolo
            }
            this.store.sessions.updateSessionMetadata(
                session.id,
                updatedMetadata,
                session.metadataVersion,
                session.namespace,
                { touchUpdatedAt: false }
            )
        }

        console.log('[SyncEngine.spawnWithResume] spawnResumedSession completed:', { sessionId: session.id })
    }

    async switchSession(sessionId: string, to: 'remote' | 'local'): Promise<void> {
        await this.rpcGateway.switchSession(sessionId, to)
    }

    async renameSession(sessionId: string, name: string): Promise<void> {
        await this.sessionCache.renameSession(sessionId, name)
    }

    async deleteSession(sessionId: string): Promise<void> {
        await this.sessionCache.deleteSession(sessionId)
    }

    async forkSession(sourceSessionId: string, enableYolo: boolean = false): Promise<string> {
        const sourceSession = this.getSession(sourceSessionId)
        if (!sourceSession) {
            throw new Error('Source session not found')
        }

        // Validate this is a Claude session
        if (sourceSession.metadata?.flavor !== 'claude') {
            throw new Error('Fork is only supported for Claude sessions')
        }

        // Validate has Claude session ID (needed for --resume --fork-session)
        if (!sourceSession.metadata?.claudeSessionId) {
            throw new Error('Cannot fork: No Claude session ID found')
        }

        // Create new session ID
        const newSessionId = randomUUID()

        // Copy metadata with modifications
        const forkedMetadata = {
            ...sourceSession.metadata,
            name: `Fork ${sourceSession.metadata.name || 'Untitled'}`,
            // Store fork flag for spawn
            shouldFork: true,
            // Set YOLO flag if requested, or inherit from source
            shouldEnableYolo: enableYolo || (sourceSession.metadata?.yolo ?? false)
        }

        // Create new session in store
        const newSession = this.store.sessions.createSession(
            newSessionId,
            sourceSession.namespace,
            forkedMetadata,
            sourceSession.agentState,
            false, // inactive
            false  // not thinking
        )

        // Load into cache
        this.sessionCache.refreshSession(newSessionId)

        return newSessionId
    }

    isSessionBusy(sessionId: string): boolean {
        const session = this.getSession(sessionId)
        if (!session) {
            throw new Error('Session not found')
        }

        // Check thinking state
        if (session.thinking) {
            return true
        }

        return false
    }

    async reloadSession(sessionId: string, force: boolean = false, enableYolo: boolean = false): Promise<void> {
        const session = this.getSession(sessionId)
        if (!session) {
            throw new Error('Session not found')
        }

        if (!session.active) {
            throw new Error('Session is not active')
        }

        // Get machine ID
        const machineId = session.metadata?.machineId
        if (!machineId) {
            throw new Error('No machine ID found for session')
        }

        // Set YOLO flag if requested
        if (enableYolo && session.metadata) {
            session.metadata.shouldEnableYolo = true
        }

        // Terminate CLI process
        await this.rpcGateway.terminateSessionProcess(sessionId, machineId, force)

        // Mark inactive (session object is mutable in cache)
        session.active = false
        session.thinking = false

        // Resume using existing logic
        await this.resumeSession(sessionId)
    }

    async applySessionConfig(
        sessionId: string,
        config: {
            permissionMode?: PermissionMode
            modelMode?: ModelMode
        }
    ): Promise<void> {
        const result = await this.rpcGateway.requestSessionConfig(sessionId, config)
        if (!result || typeof result !== 'object') {
            throw new Error('Invalid response from session config RPC')
        }
        const obj = result as { applied?: { permissionMode?: Session['permissionMode']; modelMode?: Session['modelMode'] } }
        const applied = obj.applied
        if (!applied || typeof applied !== 'object') {
            throw new Error('Missing applied session config')
        }

        this.sessionCache.applySessionConfig(sessionId, applied)
    }

    async spawnSession(
        machineId: string,
        directory: string,
        agent: 'claude' | 'codex' | 'gemini' = 'claude',
        model?: string,
        yolo?: boolean,
        sessionType?: 'simple' | 'worktree',
        worktreeName?: string
    ): Promise<{ type: 'success'; sessionId: string } | { type: 'error'; message: string }> {
        return await this.rpcGateway.spawnSession(machineId, directory, agent, model, yolo, sessionType, worktreeName)
    }

    async checkPathsExist(machineId: string, paths: string[]): Promise<Record<string, boolean>> {
        return await this.rpcGateway.checkPathsExist(machineId, paths)
    }

    async listDirectories(machineId: string, path: string): Promise<string[]> {
        return await this.rpcGateway.listDirectories(machineId, path)
    }

    async getGitStatus(sessionId: string, cwd?: string): Promise<RpcCommandResponse> {
        return await this.rpcGateway.getGitStatus(sessionId, cwd)
    }

    async getGitDiffNumstat(sessionId: string, options: { cwd?: string; staged?: boolean }): Promise<RpcCommandResponse> {
        return await this.rpcGateway.getGitDiffNumstat(sessionId, options)
    }

    async getGitDiffFile(sessionId: string, options: { cwd?: string; filePath: string; staged?: boolean }): Promise<RpcCommandResponse> {
        return await this.rpcGateway.getGitDiffFile(sessionId, options)
    }

    async readSessionFile(sessionId: string, path: string): Promise<RpcReadFileResponse> {
        return await this.rpcGateway.readSessionFile(sessionId, path)
    }

    async uploadFile(sessionId: string, filename: string, content: string, mimeType: string): Promise<RpcUploadFileResponse> {
        return await this.rpcGateway.uploadFile(sessionId, filename, content, mimeType)
    }

    async deleteUploadFile(sessionId: string, path: string): Promise<RpcDeleteUploadResponse> {
        return await this.rpcGateway.deleteUploadFile(sessionId, path)
    }

    async runRipgrep(sessionId: string, args: string[], cwd?: string): Promise<RpcCommandResponse> {
        return await this.rpcGateway.runRipgrep(sessionId, args, cwd)
    }

    async listSlashCommands(sessionId: string, agent: string): Promise<{
        success: boolean
        commands?: Array<{ name: string; description?: string; source: 'builtin' | 'user' }>
        error?: string
    }> {
        return await this.rpcGateway.listSlashCommands(sessionId, agent)
    }

    async listSkills(sessionId: string): Promise<{
        success: boolean
        skills?: Array<{ name: string; description?: string }>
        error?: string
    }> {
        return await this.rpcGateway.listSkills(sessionId)
    }
}
