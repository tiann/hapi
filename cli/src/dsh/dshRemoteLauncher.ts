import React from 'react'
import { RPC_METHODS } from '@hapi/protocol'
import { logger } from '@/ui/logger'
import { convertAgentMessage } from '@/agent/messageConverter'
import type { AgentMessage, McpServerStdio, PromptContent } from '@/agent/types'
import {
    RemoteLauncherBase,
    type RemoteLauncherDisplayContext,
    type RemoteLauncherExitReason
} from '@/modules/common/remote/RemoteLauncherBase'
import { RemoteModeDisplay } from '@/ui/ink/RemoteModeDisplay'
import { AcpPermissionHandler } from '@/modules/common/permission/AcpPermissionHandler'
import { isAcpIndeterminateError } from '@/agent/backends/acp/AcpStdioTransport'
import { buildHapiMcpBridge } from '@/codex/utils/buildHapiMcpBridge'
import { createDshBackend } from './utils/dshBackend'
import { buildDshPromptContent } from './utils/dshPromptContent'
import type { DshSession } from './session'

/**
 * Readiness handshake for the ListDshModels catalog RPC (registered once per
 * launcher in runMainLoop). A pending placeholder is armed BEFORE the
 * awaited bridge build and again at the top of every respawn, so a picker
 * query that arrives in those windows parks instead of eating a terminal
 * error (or stale metadata off a dying backend); each establishment adopts
 * the pending handshake, rebinds it to its own backend, and settles it —
 * and a respawn that fails settles it with the failure instead of hanging
 * forever. The backend of the establishment that resolves the promise
 * travels with it: the handler must query metadata on the backend that
 * captured that session, which a respawn swap keeps visible to parked
 * queries.
 */
type DshModelsReadiness = {
    /** Backend of the establishment that settles `promise`; null while the
     * handshake is a pre-establishment placeholder (establishBackend rebinds
     * it before the promise can ever resolve). */
    backend: ReturnType<typeof createDshBackend> | null
    promise: Promise<string>
    resolve: (acpSessionId: string) => void
    reject: (error: unknown) => void
    /** True once resolve/reject ran: a settled handshake can never re-arm,
     * so the next establishment replaces the object instead of adopting it. */
    settled: boolean
}

export class DshRemoteLauncher extends RemoteLauncherBase {
    private backend: ReturnType<typeof createDshBackend> | null = null
    private permissionHandler: AcpPermissionHandler | null = null
    private abortController = new AbortController()
    /** Set when a terminal session-gone prompt rejection after a cancel is
     * detected as an implicit session end (see the prompt catch in
     * runMainLoop): the next message restarts the session instead of
     * failing on the dead one forever. */
    private acpSessionEnded = false
    /** A session/cancel was issued on the current ACP session's life and no
     * (re)establishment has happened since. Custom dsh wrappers may CLOSE the
     * session on session/cancel without exiting; this flag is what makes the
     * next session-gone prompt rejection attributable to that cancel. */
    private cancelSinceEstablishment = false
    /** Bumped at the top of every handleAbort; lets the respawn branch detect
     *  an abort that landed while the replacement session was being created. */
    private abortGeneration = 0
    private currentBackendModel: string | null = null
    /** Live reasoning-effort preference ('' = Provider default); re-applied on respawn. */
    private currentReasoningEffort: string | null = null
    /** Server default captured at session creation, before any override. */
    private initialBackendModel: string | null = null
    /** ACP session id on the CURRENT backend — swapped by every respawn so
     * the main loop, abort path, and catalog RPC never act on a stale one. */
    private acpSessionId: string | null = null
    private modelsReadiness: DshModelsReadiness | null = null
    /** Guards against concurrent backend rebuilds (prompt retry vs abort). */
    private respawnInProgress = false
    /** HAPI MCP bridge HTTP server; mounted into every (re)established session. */
    private happyServer: { stop: () => void } | null = null
    /** ACP form of the hapi MCP bridge servers (name/command/args/env). */
    private acpMcpServers: McpServerStdio[] = []

    constructor(
        private readonly session: DshSession,
        private readonly opts: {
            /** Spawn-time model override (opaque ACP config-option value). */
            model?: string
            /** Spawn-time permission mode — pinned into the child env as
             * DSH_PERMISSION_MODE (read-only / danger-full-access); the dsh
             * server reads it only at spawn and has no runtime mode RPC. */
            permissionMode?: string
            onModelRollback?: (model: string | null) => void
            onConfigDiscovered?: (model: string | null) => void
            /** A reasoning-effort switch failed (or the model exposes no
             * thought_level option): the argument is the live effort
             * preference in the picker's domain — undefined = none tracked,
             * null = "Default"/provider default, string = a concrete value.
             * The host resets its tracking and re-syncs so the hub picker
             * stops showing the failed value and later turns stop
             * re-requesting it (mirror of onModelRollback). */
            onEffortRollback?: (effort: string | null | undefined) => void
        } = {}
    ) {
        super(process.env.DEBUG ? session.logPath : undefined)
    }

    async launch(): Promise<RemoteLauncherExitReason> {
        return this.start({ onExit: () => this.handleExitFromUi() })
    }

    async kill(): Promise<void> {
        if (!this.backend) return
        await this.handleAbort()
    }

    protected createDisplay(context: RemoteLauncherDisplayContext): React.ReactElement {
        return React.createElement(RemoteModeDisplay, {
            ...context,
            agentLabel: 'DeepSeek Harness'
        })
    }

    protected async runMainLoop(): Promise<void> {
        // Seed a pending placeholder BEFORE the awaited bridge build: the
        // handler below is registered immediately, and a picker query that
        // lands while the bridge HTTP server is still being built must park
        // on the placeholder — not get a terminal "not available" answer —
        // and be answered by the first establishment (which adopts it).
        this.armModelsReadiness()
        // Register the catalog RPC before initialization: a client that opens
        // the model picker while initialize/session/new is still pending
        // would otherwise hit an unregistered-method rejection, and the
        // picker has no retry path — it would stay empty until remounted.
        // The handler parks on readiness and answers once the session exists
        // and model discovery has settled, using the backend of whichever
        // establishment resolved it — a respawn swap is always visible.
        this.session.client.rpcHandlerManager.registerHandler(RPC_METHODS.ListDshModels, async () => {
            const readiness = this.modelsReadiness
            if (!readiness) {
                return { success: false, error: 'DSH session is not available' }
            }
            let acpSessionId: string
            try {
                acpSessionId = await readiness.promise
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                return { success: false, error: `DSH session is not available: ${message}` }
            }
            const metadata = readiness.backend?.getSessionModelsMetadata(acpSessionId)
            if (!metadata) {
                return { success: false, error: 'DSH model metadata is not available' }
            }
            return {
                success: true,
                availableModels: metadata.availableModels,
                currentModelId: this.currentBackendModel ?? metadata.currentModelId
            }
        })

        // DSH 0.2.2 mounts client MCP servers at session/new (stdio absolute
        // path, names ^[A-Za-z0-9_-]{1,32}$) — the old `mcpServers: []` sites
        // pinned a stale claim that it rejected non-empty mounts. Bridge the
        // hapi MCP tools exactly like the other ACP flavors; the bridge is
        // built once and remounted by every (re)establishment. Peer-tools
        // gating matches the other flavors: buildHapiMcpBridge drops
        // list_peers from the auto-approved shortlist when disabled.
        const { server: happyServer, mcpServers } = await buildHapiMcpBridge(this.session.client, {
            enableChangeTitle: false,
            skillLookup: { workingDirectory: this.session.path, flavor: 'dsh' }
        })
        this.happyServer = happyServer
        this.acpMcpServers = toAcpMcpServers(mcpServers)

        await this.establishBackend({ respawn: false })

        this.setupAbortHandlers(this.session.client.rpcHandlerManager, {
            onAbort: () => this.handleAbort(),
            onSwitch: () => this.handleExitFromUi()
        })

        while (!this.shouldExit) {
            // Capture the signal per iteration: handleAbort swaps in a fresh
            // AbortController right after aborting, so re-reading
            // this.abortController.signal below would see the replacement
            // (never aborted) and mistake an aborted wait for a closed queue,
            // exiting the loop. The captured signal stays aborted forever.
            const signal = this.abortController.signal
            const batch = await this.session.queue.waitForMessagesAndGetAsString(signal)
            if (!batch) {
                if (signal.aborted && !this.shouldExit) continue
                break
            }

            // Snapshot before any await in this iteration: a user stop that
            // lands while the dequeued batch waits for the respawn resets
            // the queue, but a batch already removed by
            // waitForMessagesAndGetAsString cannot be discarded that way —
            // the generation mismatch is what drops it.
            const generationAtDequeue = this.abortGeneration

            // A respawn that failed on an earlier batch leaves no backend
            // behind: rebuild before touching this batch. One fresh attempt
            // per message — a permanently down dsh binary surfaces one error
            // per message instead of wedging or exiting the loop.
            if (!this.backend || !this.acpSessionId) {
                let reconnected = false
                try {
                    await this.respawnBackend()
                    reconnected = true
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error)
                    logger.warn('[dsh-acp] reconnect failed', { message })
                    this.session.sendSessionEvent({ type: 'message', message: `DSH reconnect failed: ${message}` })
                    this.messageBuffer.addMessage(`DSH reconnect failed: ${message}`, 'status')
                }
                if (!reconnected) {
                    if (this.session.queue.size() === 0 && !this.shouldExit) {
                        this.session.sendSessionEvent({ type: 'ready' })
                    }
                    continue
                }
                if (generationAtDequeue !== this.abortGeneration) {
                    // A user stop landed while the replacement backend was
                    // being established: the user already saw 'Session
                    // aborted' and the queue was reset, so this already-
                    // dequeued batch must not run (same contract as the
                    // mid-prompt reconnect below).
                    this.messageBuffer.addMessage('Aborted while reconnecting the DSH session; dropping the queued message', 'status')
                    if (this.session.queue.size() === 0 && !this.shouldExit) {
                        this.session.sendSessionEvent({ type: 'ready' })
                    }
                    continue
                }
            }

            // Reference the CURRENT backend/session per iteration (not a
            // const captured at loop start): a respawn swaps both.
            const backend = this.backend!
            let acpSessionId = this.acpSessionId!

            if (this.acpSessionEnded) {
                // A custom dsh wrapper may CLOSE the ACP session on
                // session/cancel without exiting the process — invisible on
                // the standard-cancel path, detected through the next
                // prompt's session-gone rejection (below). The closed
                // session stays durable on disk, so resume it for the next
                // message: an abort must not cost the conversation history
                // (verified against dsh 0.2.x: session/close →
                // session/resume keeps every prior turn). Only when the
                // stored id no longer resumes (cleaned ~/.dsh, version
                // migration) start fresh.
                // Snapshot the abort generation: an abort landing while the
                // replacement session is being created targets the old session
                // id and must also discard the already-dequeued batch (the user
                // saw 'Session aborted').
                const generationBeforeRespawn = this.abortGeneration
                let resumed = false
                try {
                    if (this.session.sessionId && backend.supportsSessionResume()) {
                        try {
                            acpSessionId = await backend.resumeSession({
                                sessionId: this.session.sessionId,
                                cwd: this.session.path,
                                // Same cwd as the original establishment: dsh
                                // compares the resume cwd by realpath and rejects
                                // mismatches terminally (invalidParams).
                                mcpServers: this.acpMcpServers
                            })
                            resumed = true
                        } catch (error) {
                            // Mirror the startup path: a stale on-disk session must
                            // not strand the HAPI session.
                            const message = error instanceof Error ? error.message : String(error)
                            logger.warn('[dsh-acp] session/resume after abort failed; starting a fresh session', { message })
                        }
                    }
                    if (!resumed) {
                        acpSessionId = await backend.newSession({
                            cwd: this.session.path,
                            mcpServers: this.acpMcpServers
                        })
                    }
                } catch (error) {
                    // The backend itself died inside the recovery window
                    // (child exit, closed transport): every RPC on it now
                    // rejects the same way, so let the exception escape the
                    // recovery instead of the loop — surface one error, drop
                    // the batch, clear the dead backend so the next message
                    // goes through the reconnect branch, and keep the
                    // ended marker so recovery is retried after the rebuild.
                    const message = error instanceof Error ? error.message : String(error)
                    logger.warn('[dsh-acp] session restart failed; the backend will be rebuilt for the next message', { message })
                    const failureMessage = `DSH session restart failed: ${message}`
                    this.session.sendSessionEvent({ type: 'message', message: failureMessage })
                    this.messageBuffer.addMessage(failureMessage, 'status')
                    this.backend = null
                    this.acpSessionId = null
                    this.session.onThinkingChange(false)
                    if (this.session.queue.size() === 0 && !this.shouldExit) {
                        this.session.sendSessionEvent({ type: 'ready' })
                    }
                    continue
                }
                this.acpSessionId = acpSessionId
                // Re-pin through onSessionFound: the respawn replaces the stored
                // dshSessionId, so a runner restart resumes the live session.
                this.session.onSessionFound(acpSessionId)
                if (!resumed) {
                    // The fresh session starts from the server default — the
                    // closed session's model/effort config died with it. Mirror
                    // the respawn contract from establishBackend so the batch
                    // (or, when an abort lands mid-recreation, the NEXT message
                    // resuming this persisted session) runs on the preferences
                    // the session was showing.
                    const modelOption = backend.getConfigOptionByCategory(acpSessionId, 'model')
                    if (this.currentBackendModel && modelOption && modelOption.currentValue !== this.currentBackendModel) {
                        await this.applyModelSwitch(backend, acpSessionId, this.currentBackendModel)
                    } else if (!this.currentBackendModel) {
                        // No preference to re-apply: the fresh session IS the
                        // new source of truth — capture its default so a later
                        // explicit "Default" reset has something to switch back
                        // to, and keep the picker on the live model.
                        this.initialBackendModel = modelOption?.currentValue
                            ?? backend.getSessionModelsMetadata(acpSessionId)?.currentModelId
                            ?? null
                        this.currentBackendModel = this.initialBackendModel
                    }
                    if (this.currentReasoningEffort !== null) {
                        // Same re-apply + drop-on-failure contract as a respawn:
                        // the fresh session is the preference's only chance to
                        // re-materialize, so a value it rejects is cleared.
                        const reapplied = await this.applyEffortValue(backend, acpSessionId, this.currentReasoningEffort)
                        if (reapplied === null) {
                            this.currentReasoningEffort = null
                            this.opts.onEffortRollback?.(undefined)
                        }
                    }
                }
                if (generationBeforeRespawn !== this.abortGeneration) {
                    // Aborted mid-recreation: drop the batch and treat the fresh
                    // session as ended so the next loop respawns cleanly instead
                    // of running a message the user aborted.
                    this.acpSessionEnded = true
                    this.messageBuffer.addMessage('Aborted while restarting the DSH session; dropping the queued message', 'status')
                    continue
                }
                this.acpSessionEnded = false
                // The replacement session is live: a later session-gone
                // rejection cannot be attributed to the earlier cancel.
                this.cancelSinceEstablishment = false
                this.messageBuffer.addMessage(resumed ? 'DSH session resumed after abort' : 'DSH session restarted after abort', 'status')
            }

            const requestedModel = batch.mode.model
            if (requestedModel === null) {
                // Explicit "Default": switch back to the server default captured
                // at session creation. The web picker resets the session model
                // to null and the next queued turn carries it here.
                if (this.initialBackendModel && this.initialBackendModel !== this.currentBackendModel) {
                    const applied = await this.applyModelSwitch(backend, acpSessionId, this.initialBackendModel)
                    if (applied) {
                        batch.mode.model = applied
                    } else {
                        batch.mode.model = this.currentBackendModel ?? undefined
                        this.opts.onModelRollback?.(this.currentBackendModel)
                    }
                } else if (!this.initialBackendModel) {
                    // Nothing captured to go back to — keep the running model and
                    // report it back so the picker does not claim "Default".
                    batch.mode.model = this.currentBackendModel ?? undefined
                    this.opts.onModelRollback?.(this.currentBackendModel)
                    this.session.sendSessionEvent({
                        type: 'message',
                        message: 'Cannot reset the DSH model: the agent did not report a default model.'
                    })
                } else {
                    // Already running the default.
                    batch.mode.model = this.currentBackendModel ?? undefined
                }
            } else if (requestedModel && requestedModel !== this.currentBackendModel) {
                const applied = await this.applyModelSwitch(backend, acpSessionId, requestedModel)
                if (applied) {
                    batch.mode.model = applied
                } else {
                    batch.mode.model = this.currentBackendModel ?? undefined
                    this.opts.onModelRollback?.(this.currentBackendModel)
                }
            }

            // DSH surfaces reasoning effort as the 'reasoning_effort' config
            // option (category thought_level; '' = Provider default). The web
            // reasoning-effort picker drives this via the queued turn's mode.
            const requestedEffort = batch.mode.modelReasoningEffort
            if (requestedEffort !== undefined) {
                const appliedEffort = await this.applyReasoningEffort(backend, acpSessionId, requestedEffort)
                if (appliedEffort === null) {
                    // Same contract as the model switch: the failed
                    // preference never took, so the host's tracking (and
                    // through it the hub picker) is corrected back to the
                    // live value — later turns stop re-requesting the failed
                    // one, and the respawn below skips it too.
                    this.opts.onEffortRollback?.(this.liveEffortPreference())
                }
            }

            this.session.onThinkingChange(true)
            this.messageBuffer.addMessage(batch.message, 'user')
            // Image attachments are read once here (authorized per session)
            // and the built content is reused verbatim by the respawn retry,
            // so a reconnect never re-reads or re-orders the batch's images.
            // Per-image failures are handled inside (status notice + skip);
            // this guard only catches unexpected preparation errors so they
            // degrade to a text-only turn instead of killing the loop.
            let prompt: PromptContent[]
            try {
                prompt = await buildDshPromptContent(
                    backend,
                    batch.message,
                    batch.mode.imageAttachments,
                    {
                        sessionId: this.session.client.sessionId,
                        onNotice: (message) => this.session.sendSessionEvent({ type: 'message', message })
                    }
                )
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                logger.warn('[dsh-acp] prompt preparation failed', { message })
                prompt = [{ type: 'text', text: batch.message }]
            }
            if (generationAtDequeue !== this.abortGeneration) {
                // A user stop landed while the prompt content was being
                // prepared (image reads await): the user already saw
                // 'Session aborted' and the queue was reset, so the
                // already-dequeued batch must not run (same contract as the
                // reconnect windows).
                this.messageBuffer.addMessage('Aborted while preparing the DSH prompt; dropping the queued message', 'status')
                this.session.onThinkingChange(false)
                await this.permissionHandler?.cancelAll('Prompt finished')
                if (this.session.queue.size() === 0 && !this.shouldExit) {
                    this.session.sendSessionEvent({ type: 'ready' })
                }
                continue
            }
            let failureMessage: string | null = null
            try {
                await backend.prompt(acpSessionId, prompt, (message) => this.handleAgentMessage(message))
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                logger.warn('[dsh-acp] prompt failed', { message })
                // isAcpIndeterminateError is the transport's own typed marker
                // for failures whose request never reached a JSON-RPC outcome
                // (child exited, transport closed, stdin write failed). For
                // session/prompt — which carries an infinite timeout — that
                // marker means exactly one thing: the dsh child process died
                // and the closed transport would fail every later request the
                // same way. Regular JSON-RPC rejections (unknown session,
                // etc.) do not carry it and keep the surface-and-continue
                // behavior.
                if (isAcpIndeterminateError(error) && !this.shouldExit) {
                    // Rebuild the backend, resume the pinned dshSessionId on a
                    // fresh child, re-apply the live model, and retry THIS
                    // batch exactly once; a failure here surfaces and falls
                    // through — the loop stays alive and the next message
                    // attempts a fresh respawn.
                    let revived = false
                    try {
                        await this.respawnBackend()
                        revived = true
                    } catch (respawnError) {
                        const reconnectMessage = respawnError instanceof Error ? respawnError.message : String(respawnError)
                        logger.warn('[dsh-acp] reconnect failed', { message: reconnectMessage })
                        failureMessage = `DSH reconnect failed: ${reconnectMessage}`
                    }
                    if (revived) {
                        if (generationAtDequeue !== this.abortGeneration) {
                            // A user stop landed while the replacement backend
                            // was being established: the user already saw
                            // 'Session aborted' and the queue was reset, so
                            // the retried batch must not run.
                            this.messageBuffer.addMessage('Aborted while reconnecting the DSH session; dropping the queued message', 'status')
                        } else {
                            try {
                                await this.backend!.prompt(this.acpSessionId!, prompt, (message) => this.handleAgentMessage(message))
                            } catch (retryError) {
                                const retryMessage = retryError instanceof Error ? retryError.message : String(retryError)
                                logger.warn('[dsh-acp] prompt failed after reconnect', { message: retryMessage })
                                failureMessage = `DSH prompt failed after reconnect: ${retryMessage}`
                            }
                        }
                    }
                } else if (this.cancelSinceEstablishment && isSessionGoneRejection(message)) {
                    // Implicit session-end detection. The official dsh server
                    // keeps the session alive across session/cancel, but
                    // custom wrappers (HAPI_DSH_ACP_COMMAND) may CLOSE the
                    // session on the notification without exiting — and the
                    // standard cancel path has no event for that, so every
                    // later prompt would fail forever on the dead session.
                    // The terminal unknown/expired-session rejection IS the
                    // observable signal: mark the session ended so the next
                    // loop iteration re-enters the restart branch (resume the
                    // stored id, or start fresh when it no longer resumes).
                    this.acpSessionEnded = true
                    this.messageBuffer.addMessage('DSH session ended by the earlier cancel; it will be restarted for the next message', 'status')
                    failureMessage = `DSH prompt failed (session closed by the earlier cancel; restarting it for the next message): ${message}`
                } else {
                    failureMessage = `DSH prompt failed: ${message}`
                }
            }
            if (failureMessage !== null) {
                this.session.sendSessionEvent({ type: 'message', message: failureMessage })
                this.messageBuffer.addMessage(failureMessage, 'status')
            }
            this.session.onThinkingChange(false)
            await this.permissionHandler?.cancelAll('Prompt finished')
            if (this.session.queue.size() === 0 && !this.shouldExit) {
                this.session.sendSessionEvent({ type: 'ready' })
            }
        }
    }

    /**
     * Create a dsh backend and drive it to a live, fully configured ACP
     * session: initialize → resume-or-new session → pin + flush
     * dshSessionId → model discovery/override → catalog readiness →
     * permission handler.
     *
     * Shared by the initial launch and by post-death respawns. The `respawn`
     * flag only changes model handling: an initial establishment captures the
     * server default and applies the spawn-time override, while a respawn
     * keeps the captured default and re-applies the LIVE user preference.
     */
    private async establishBackend(opts: { respawn: boolean }): Promise<void> {
        const backend = createDshBackend(process.env, { permissionMode: this.opts.permissionMode })
        this.backend = backend
        this.acpSessionId = null
        backend.onStderrError((error) => {
            logger.debug('[dsh-acp] stderr error', error)
            this.session.sendSessionEvent({ type: 'message', message: error.message })
            this.messageBuffer.addMessage(error.message, 'status')
        })

        // Adopt the pending handshake armed before this establishment began
        // (a query that parked during the bridge build or the respawn
        // teardown must be answered by THIS establishment); when the standing
        // handshake is settled — a finished or failed earlier establishment —
        // arm a fresh one. The backend rebind happens before any await below,
        // so a resolve can only ever surface the establishment's own backend.
        const readiness = (!this.modelsReadiness || this.modelsReadiness.settled)
            ? this.armModelsReadiness()
            : this.modelsReadiness
        readiness.backend = backend

        let acpSessionId: string
        try {
            await backend.initialize()
            const resumeSessionId = this.session.sessionId
            if (resumeSessionId && backend.supportsSessionResume()) {
                try {
                    acpSessionId = await backend.resumeSession({
                        sessionId: resumeSessionId,
                        cwd: this.session.path,
                        // dsh compares the resume cwd by realpath and rejects
                        // mismatches terminally: this is the SAME cwd the
                        // session was originally created with (session.path),
                        // so a respawn after a child death resumes cleanly.
                        mcpServers: this.acpMcpServers
                    })
                    this.messageBuffer.addMessage('DSH session resumed', 'status')
                } catch (error) {
                    // The on-disk dsh session may be gone (cleaned ~/.dsh, version
                    // migration): start fresh instead of stranding the HAPI session.
                    const message = error instanceof Error ? error.message : String(error)
                    logger.warn('[dsh-acp] session/resume failed; starting a fresh session', { message })
                    acpSessionId = await backend.newSession({
                        cwd: this.session.path,
                        mcpServers: this.acpMcpServers
                    })
                    this.messageBuffer.addMessage('DSH resume failed; started a fresh session', 'status')
                }
            } else {
                acpSessionId = await backend.newSession({
                    cwd: this.session.path,
                    mcpServers: this.acpMcpServers
                })
            }
            this.acpSessionId = acpSessionId
            // The (re)established session is live: an implicit session end
            // flagged on a previous session does not apply to this one.
            this.acpSessionEnded = false
            this.cancelSinceEstablishment = false
            // Pin dshSessionId before the main loop so a runner restart can resume
            // (tiann/hapi#913: gate until the metadata write reaches the hub — a
            // SIGTERM before that strands the session). Persist even when the id
            // matches the requested resume: an explicit `--resume` on a fresh
            // HAPI row must still store it, and re-pinning a stored id is an
            // idempotent metadata merge.
            this.session.onSessionFound(acpSessionId)
            const flushed = await this.session.client.flushMetadata()
            if (!flushed) {
                logger.warn(`[dsh-acp] dshSessionId metadata write did not ACK within the flush window (acpSessionId=${acpSessionId})`)
            }
        } catch (error) {
            readiness.reject(error)
            throw error
        }

        const modelOption = backend.getConfigOptionByCategory(acpSessionId, 'model')
        if (!opts.respawn) {
            // Capture the server default BEFORE applying any override: an explicit
            // "Default" reset later in the session (queued as model: null) switches
            // back to this value; without it the reset would silently keep the
            // last explicitly-applied model.
            this.initialBackendModel = modelOption?.currentValue
                ?? backend.getSessionModelsMetadata(acpSessionId)?.currentModelId
                ?? null
            if (this.opts.model && modelOption) {
                this.currentBackendModel = await this.applyModelSwitch(backend, acpSessionId, this.opts.model)
            }
            if (!this.currentBackendModel) {
                this.currentBackendModel = this.initialBackendModel
            }
            this.opts.onConfigDiscovered?.(this.currentBackendModel)
        } else if (this.currentBackendModel && modelOption && modelOption.currentValue !== this.currentBackendModel) {
            // The respawned child starts from whatever the server persisted;
            // re-apply the live user preference so the retried batch runs on
            // the model the session is showing.
            await this.applyModelSwitch(backend, acpSessionId, this.currentBackendModel)
        }
        if (opts.respawn && this.currentReasoningEffort !== null) {
            // Same re-apply contract as the model preference, with one
            // difference: a failure here DROPS the effort preference. The
            // fresh session is the preference's only chance to re-materialize
            // (the old session it was proven on is gone), so a value the new
            // session rejects — e.g. after a model switch to one without that
            // effort level — is cleared instead of failing every later
            // respawn; the host is told so the hub picker follows.
            const reapplied = await this.applyEffortValue(backend, acpSessionId, this.currentReasoningEffort)
            if (reapplied === null) {
                this.currentReasoningEffort = null
                this.opts.onEffortRollback?.(undefined)
            }
        }
        if (this.currentBackendModel) {
            this.messageBuffer.addMessage(`[MODEL:${this.currentBackendModel}]`, 'system')
        }
        readiness.resolve(acpSessionId)

        this.permissionHandler = new AcpPermissionHandler(
            this.session.client,
            backend,
            // The session's current permission mode drives auto-approval
            // decisions (e.g. yolo approves for the session); without this,
            // every DSH permission request escalates to a permission card.
            // Mid-session mode switches stay HAPI-side auto-approval: dsh
            // has no runtime mode RPC, so only the spawn-time
            // DSH_PERMISSION_MODE reaches the server sandbox.
            () => this.session.getPermissionMode(),
            {
                // Permission 'abort' decisions cancel through the backend
                // directly and never enter handleAbort: arm the implicit-end
                // detector for that cancel, mirroring handleAbort.
                onCancelIssued: () => {
                    this.cancelSinceEstablishment = true
                }
            }
        )
    }

    /**
     * Arm a fresh pending readiness handshake, make it current, and return
     * it. Called before the bridge build (pre-first-establishment
     * placeholder) and at the top of every respawn (before the teardown
     * awaits): catalog queries that arrive in those windows park on it.
     * establishBackend adopts the pending handshake, rebinds its backend,
     * and settles it with the establishment's outcome.
     */
    private armModelsReadiness(): DshModelsReadiness {
        let markReady!: (acpSessionId: string) => void
        let markFailed!: (error: unknown) => void
        const ready = new Promise<string>((resolve, reject) => {
            markReady = resolve
            markFailed = reject
        })
        // A failing establishment rejects `ready` through the reject wrapper;
        // with no catalog query parked on it yet, that rejection would
        // otherwise surface as an unhandled promise rejection.
        ready.catch(() => {})
        const readiness: DshModelsReadiness = {
            backend: null,
            promise: ready,
            settled: false,
            resolve: (acpSessionId) => {
                readiness.settled = true
                markReady(acpSessionId)
            },
            reject: (error) => {
                readiness.settled = true
                markFailed(error)
            }
        }
        this.modelsReadiness = readiness
        return readiness
    }

    /**
     * Tear down a dead backend and re-establish the ACP session on a fresh
     * `dsh --profile acp` child process.
     *
     * Once the dsh child dies its transport is closed permanently — every
     * request on it rejects immediately — so recovery requires a brand-new
     * backend: initialize, resume the pinned durable dshSessionId with the
     * SAME cwd used originally (dsh rejects mismatched resume cwds by
     * realpath comparison), re-apply the current model preference, and
     * re-arm the catalog readiness. Posts exactly one 'connection lost;
     * reconnecting' status line per attempt.
     *
     * Throws when re-establishment fails; `this.backend` is then null so the
     * next message starts a fresh attempt instead of reusing the corpse.
     */
    private async respawnBackend(): Promise<void> {
        if (this.respawnInProgress) {
            throw new Error('DSH reconnect already in progress')
        }
        this.respawnInProgress = true
        try {
            this.session.sendSessionEvent({ type: 'message', message: 'DSH connection lost; reconnecting…' })
            this.messageBuffer.addMessage('DSH connection lost; reconnecting…', 'status')
            const deadBackend = this.backend
            const deadPermissionHandler = this.permissionHandler
            // Detach everything bound to the dead backend BEFORE rebuilding so
            // concurrent aborts, catalog queries, and the retry below can only
            // ever observe the replacement.
            this.backend = null
            this.acpSessionId = null
            this.permissionHandler = null
            // Swap the catalog readiness to a fresh pending handshake BEFORE
            // the teardown awaits below: the standing one is settled on the
            // dead backend, and a picker query that lands while
            // cancelAll/disconnect are still in flight must park here to be
            // answered by the replacement establishment — not be served stale
            // metadata off the corpse. establishBackend adopts it.
            this.armModelsReadiness()
            try {
                await deadPermissionHandler?.cancelAll('DSH connection lost')
            } catch (error) {
                logger.debug('[dsh-acp] permission cancelAll during reconnect failed', error)
            }
            try {
                await deadBackend?.disconnect()
            } catch (error) {
                logger.debug('[dsh-acp] disconnect of dead backend failed', error)
            }
            await this.establishBackend({ respawn: true })
        } catch (error) {
            // establishBackend may have parked a half-initialized backend in
            // this.backend; drop it so the next message rebuilds cleanly.
            const partial = this.backend
            this.backend = null
            this.acpSessionId = null
            // A catalog query that parked during the teardown or the failed
            // rebuild must get the failure, not an eternal park: settle the
            // handshake armed at the top of this respawn (establishBackend
            // already settled its own adoptee, so this is usually a no-op —
            // it covers failures that predate the adopt, e.g. a synchronous
            // backend-factory throw). The next respawn attempt re-arms.
            const pending = this.modelsReadiness
            if (pending && !pending.settled) {
                pending.reject(error)
            }
            try {
                await partial?.disconnect()
            } catch (disconnectError) {
                logger.debug('[dsh-acp] disconnect of partial backend failed', disconnectError)
            }
            throw error
        } finally {
            this.respawnInProgress = false
        }
    }

    protected async cleanup(): Promise<void> {
        this.clearAbortHandlers(this.session.client.rpcHandlerManager)
        await this.permissionHandler?.cancelAll('Session ended')
        this.permissionHandler = null
        await this.backend?.disconnect()
        this.backend = null
        if (this.happyServer) {
            this.happyServer.stop()
            this.happyServer = null
        }
    }

    private handleAgentMessage(message: AgentMessage): void {
        const converted = convertAgentMessage(message)
        if (converted) this.session.sendAgentMessage(converted)

        switch (message.type) {
            case 'text':
                // Interim idle snapshots; the settled text arrives at the
                // segment boundary, which is what belongs in the local log.
                if (message.live) break
                this.messageBuffer.addMessage(message.text, 'assistant')
                break
            case 'generated_image':
                this.messageBuffer.addMessage(`Generated image: ${message.fileName}`, 'assistant')
                break
            case 'error':
                this.messageBuffer.addMessage(message.message, 'status')
                break
            case 'turn_complete':
                // dsh reports stopReason end_turn | max_tokens | cancelled
                // (verified against 0.2.2-rc.1): a max_tokens turn was cut
                // short by the context limit and must not read as a normal
                // completion.
                if (message.stopReason === 'max_tokens') {
                    // Remote clients see the transcript, not this local log:
                    // publish the truncation through the session event
                    // channel too, or a cut-short turn just falls silent in
                    // the web/mobile UI.
                    this.session.sendSessionEvent({
                        type: 'message',
                        message: 'Turn truncated: the model hit its output limit before finishing (max_tokens).'
                    })
                    this.messageBuffer.addMessage('Turn truncated: context limit reached', 'status')
                } else {
                    this.messageBuffer.addMessage('Turn complete', 'status')
                }
                break
            case 'usage':
            case 'reasoning':
            case 'tool_call':
            case 'tool_result':
            case 'plan':
            case 'round_summary':
                break
            default: {
                const _exhaustive: never = message
                return _exhaustive
            }
        }
    }

    /**
     * Switch the DSH model through `session/set_config_option` — dsh does not
     * implement `session/set_model` (verified against 0.2.0-rc.2: -32601).
     * Model ids are opaque config-option values (JSON provider+model tuples)
     * and are sent back verbatim; unknown ids fail loud with -32602.
     * Returns the applied model, or null when the switch failed (caller keeps
     * the previous model).
     */
    private async applyModelSwitch(
        backend: ReturnType<typeof createDshBackend>,
        acpSessionId: string,
        model: string
    ): Promise<string | null> {
        const option = backend.getConfigOptionByCategory(acpSessionId, 'model')
        if (!option) {
            logger.warn('[dsh-acp] Cannot switch model: agent exposes no model config option')
            this.session.sendSessionEvent({
                type: 'message',
                message: 'Cannot switch model: the DSH agent exposes no model config option.'
            })
            return null
        }
        try {
            await backend.setConfigOption(acpSessionId, option.id, model)
            this.currentBackendModel = model
            this.messageBuffer.addMessage(`[MODEL:${model}]`, 'system')
            return model
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            logger.warn('[dsh-acp] model switch failed', { message })
            this.session.sendSessionEvent({
                type: 'message',
                message: `Failed to switch DSH model: ${message}`
            })
            return null
        }
    }

    /**
     * Apply a reasoning-effort change through the 'reasoning_effort' config
     * option (category thought_level). DSH's value space is the model's
     * effort ids (off/low/high/max for DeepSeek) with '' = Provider default,
     * so the picker's null ("Default") maps to ''. Returns the applied value,
     * or null when the switch failed or the model exposes no thought_level
     * option (the caller keeps the previous effort and corrects the host via
     * onEffortRollback) — the same contract as applyModelSwitch. A request
     * that already matches the live value returns it without a wire call.
     */
    private async applyReasoningEffort(
        backend: ReturnType<typeof createDshBackend>,
        acpSessionId: string,
        effort: string | null
    ): Promise<string | null> {
        const value = effort ?? ''
        if (value === this.currentReasoningEffort) return value
        return this.applyEffortValue(backend, acpSessionId, value)
    }

    /**
     * Fire the set_config_option for a concrete effort value without the
     * preference dedupe — the respawn path re-applies the live preference to
     * a FRESH session whose server-side thought level is unknown, so even a
     * value equal to `currentReasoningEffort` must go over the wire.
     * Only a success updates the tracked preference; on failure the previous
     * value stands and null is returned.
     */
    private async applyEffortValue(
        backend: ReturnType<typeof createDshBackend>,
        acpSessionId: string,
        value: string
    ): Promise<string | null> {
        const option = backend.getConfigOptionByCategory(acpSessionId, 'thought_level')
        if (!option) {
            logger.warn('[dsh-acp] Cannot set reasoning effort: agent exposes no thought_level config option')
            this.session.sendSessionEvent({
                type: 'message',
                message: 'Cannot set reasoning effort: the current DSH model exposes no thought levels.'
            })
            return null
        }
        try {
            await backend.setConfigOption(acpSessionId, option.id, value)
            this.currentReasoningEffort = value
            this.messageBuffer.addMessage(`[EFFORT:${value || 'default'}]`, 'system')
            return value
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            logger.warn('[dsh-acp] reasoning effort switch failed', { message })
            this.session.sendSessionEvent({
                type: 'message',
                message: `Failed to switch DSH reasoning effort: ${message}`
            })
            return null
        }
    }

    /** The live effort preference in the picker's domain: undefined = none
     * tracked, null = "Default" (DSH's ''), string = a concrete value. This
     * is what onEffortRollback reports after a failed apply. */
    private liveEffortPreference(): string | null | undefined {
        if (this.currentReasoningEffort === null) return undefined
        return this.currentReasoningEffort === '' ? null : this.currentReasoningEffort
    }

    private async handleAbort(): Promise<void> {
        // Bump first, synchronously: the respawn branch compares generations
        // around its resume/new-session `await`s to detect aborts that land
        // inside that window.
        this.abortGeneration += 1
        // Tear the queue down synchronously, BEFORE awaiting the cancel: the
        // in-flight prompt can complete while the cancel notification is
        // still on the wire, and the loop would then dequeue a follow-up
        // queued before the stop — a reset scheduled after the await is too
        // late. Aborting (and replacing) the controller first also unparks a
        // waiting loop iteration via the captured signal so it re-waits on
        // the fresh controller instead of spinning on the aborted one.
        this.abortController.abort()
        this.abortController = new AbortController()
        this.session.queue.reset()
        // Arm the implicit-end detector: this session/cancel keeps the
        // official server's session alive, but a custom wrapper may close it
        // — observable only through the next prompt's terminal session-gone
        // rejection.
        this.cancelSinceEstablishment = true
        // Reads the CURRENT backend: after a respawn this cancels on the
        // replacement; mid-respawn it is null and the skip is correct (the
        // dead transport cannot accept a cancel anyway).
        if (this.backend && this.session.sessionId) {
            await this.backend.cancelPrompt(this.session.sessionId)
        }
        await this.permissionHandler?.cancelAll('User aborted')
        this.session.sendSessionEvent({ type: 'message', message: 'Session aborted' })
        this.session.onThinkingChange(false)
        this.messageBuffer.addMessage('Turn aborted', 'status')
    }

    private handleExitFromUi(): Promise<void> {
        return this.requestExit('exit', () => this.handleAbort())
    }
}

function toAcpMcpServers(config: Record<string, { command: string; args: string[] }>): McpServerStdio[] {
    return Object.entries(config).map(([name, entry]) => ({
        name,
        command: entry.command,
        args: entry.args,
        env: []
    }))
}

/** Terminal session-gone JSON-RPC rejection phrasings, matched on the error
 * message: the ACP transport drops the JSON-RPC error code and rejects with
 * `new Error(message)`, so the phrasing is the only identity available.
 * These are the answers a server gives when the targeted session no longer
 * exists — e.g. a custom dsh wrapper (HAPI_DSH_ACP_COMMAND) that closed the
 * session on session/cancel. Used only for the implicit session-end
 * detection in runMainLoop, gated on a cancel having been issued earlier in
 * the same session's life. */
const SESSION_GONE_REJECTION_PATTERNS = [
    'session not found',
    'unknown session',
    'no such session',
    'session expired',
    'expired session',
    'session has expired',
    'session already closed',
    'session is closed'
]

function isSessionGoneRejection(message: string): boolean {
    const normalized = message.toLowerCase()
    return SESSION_GONE_REJECTION_PATTERNS.some((pattern) => normalized.includes(pattern))
}
