import React from 'react'
import type { PermissionMode } from '@hapi/protocol/types'
import { logger } from '@/ui/logger'
import { convertAgentMessage } from '@/agent/messageConverter'
import type { AgentMessage, PromptContent } from '@/agent/types'
import {
    RemoteLauncherBase,
    type RemoteLauncherDisplayContext,
    type RemoteLauncherExitReason
} from '@/modules/common/remote/RemoteLauncherBase'
import { RemoteModeDisplay } from '@/ui/ink/RemoteModeDisplay'
import { AcpPermissionHandler } from '@/modules/common/permission/AcpPermissionHandler'
import { isAcpIndeterminateError } from '@/agent/backends/acp/AcpStdioTransport'
import { createBerryBackend, resolveBerryDataDir } from './utils/berryBackend'
import { buildBerryPromptContent } from './utils/berryPromptContent'
import type { BerrySession } from './session'

export class BerryRemoteLauncher extends RemoteLauncherBase {
    private backend: ReturnType<typeof createBerryBackend> | null = null
    private permissionHandler: AcpPermissionHandler | null = null
    private abortController = new AbortController()
    /** The session's model, seeded from the spawn-time lever
     * (BERRY_AGENT_MODEL). Berry has no runtime model surface, so this never
     * changes after launch — it exists so the host can be told what the
     * session runs on. */
    private currentBackendModel: string | null = null
    private displayPermissionMode: PermissionMode | undefined
    /** Isolated berry dataDir (sessions.db + sticky tool-policy.json) keyed
     * by the HAPI row id — stable across respawns and runner restarts. */
    private readonly dataDir: string

    constructor(
        private readonly session: BerrySession,
        private readonly opts: {
            /** Spawn-time model override (`provider/model-id`; passed to the
             * child as BERRY_AGENT_MODEL — berry's only model lever, read at
             * process start; there is no runtime switch to apply). */
            model?: string
            onConfigDiscovered?: (model: string | null) => void
        } = {}
    ) {
        super(process.env.DEBUG ? session.logPath : undefined)
        this.dataDir = resolveBerryDataDir(session.client.sessionId)
    }

    async launch(): Promise<RemoteLauncherExitReason> {
        return this.start({ onExit: () => this.handleExitFromUi() })
    }

    async kill(): Promise<void> {
        if (!this.backend) return
        await this.handleAbort()
    }

    /**
     * Mirror a mid-session permission-mode switch into the terminal log.
     *
     * Berry has no session/set_mode (and no other runtime mode RPC): the
     * HAPI permission bridge is the ONLY live enforcement — it consults the
     * session's current mode through the getter handed to
     * AcpPermissionHandler on every request_permission (read-only denies
     * writes via the classifier, yolo auto-approves), so a switch takes
     * effect on the very next request without any agent-side push. All this
     * method does is publish the display mode immediately instead of at the
     * next turn boundary.
     */
    async applyModeNow(): Promise<void> {
        if (!this.backend || !this.session.sessionId) return
        this.applyDisplayMode(this.session.getPermissionMode() as PermissionMode | undefined)
    }

    protected createDisplay(context: RemoteLauncherDisplayContext): React.ReactElement {
        return React.createElement(RemoteModeDisplay, {
            ...context,
            agentLabel: 'Berry'
        })
    }

    /**
     * Spawn a berry ACP backend with the session's spawn-time levers: the
     * model override (BERRY_AGENT_MODEL) and the isolated data dir
     * (BERRY_AGENT_DATA_DIR). Berry reads both only at process start, so
     * every backend creation — initial launch and respawn alike — must go
     * through here.
     */
    private spawnBackend(): ReturnType<typeof createBerryBackend> {
        const backend = createBerryBackend(process.env, {
            model: this.opts.model,
            dataDir: this.dataDir
        })
        backend.onStderrError((error) => {
            logger.debug('[berry-acp] stderr error', error)
            this.session.sendSessionEvent({ type: 'message', message: error.message })
            this.messageBuffer.addMessage(error.message, 'status')
        })
        return backend
    }

    protected async runMainLoop(): Promise<void> {
        // `let`: a mid-loop respawn replaces both the backend instance and the
        // ACP session id it talks to.
        let backend = this.spawnBackend()
        this.backend = backend
        // Native session_info_update titles are deliberately NOT mirrored:
        // the Hub owns Berry session titles, matching the other ACP flavors
        // without a native rename tool. Mirroring a native title into
        // metadata.summary would suppress the Hub's own title generation.

        // No ListBerryModels catalog RPC: the hub route is retired and berry
        // exposes no model config-option surface to read one from (the rail
        // was a phantom — BERRY_AGENT_MODEL at spawn is the only lever).

        await backend.initialize()
        let acpSessionId = await this.establishAcpSession(backend)
        this.session.onSessionFound(acpSessionId)

        // Berry's ONLY model lever is spawn-time: BERRY_AGENT_MODEL is read
        // once at process start (spawnBackend above) and the agent has no
        // runtime model RPC — so there is nothing to discover or switch, and
        // queued mode.model fields are ignored rather than answered with a
        // 'Cannot switch model' failure. Seed the tracked model from the
        // spawn lever so the host still learns what the session runs on.
        this.currentBackendModel = this.opts.model ?? null
        this.opts.onConfigDiscovered?.(this.currentBackendModel)
        if (this.currentBackendModel) {
            this.messageBuffer.addMessage(`[MODEL:${this.currentBackendModel}]`, 'system')
        }

        // Auto-approval consults the LIVE session mode through the getter:
        // a mid-turn switch to yolo starts auto-approving request_permission
        // immediately. Berry has no agent-side mode axis to push (no
        // session/set_mode, no sandbox preset RPC) — the HAPI permission
        // bridge is the only enforcement layer.
        this.permissionHandler = new AcpPermissionHandler(
            this.session.client,
            backend,
            () => this.session.getPermissionMode() as PermissionMode | undefined,
            // Berry persists allow_always answers STICKILY in tool-policy.json
            // (surviving even process restarts). A HAPI "allow for session"
            // pick means exactly one session, so it must map to allow_once
            // there; other flavors keep the shared default.
            { sessionScopedPermissionGrants: true }
        )
        this.applyDisplayMode(this.session.getPermissionMode() as PermissionMode | undefined)
        this.setupAbortHandlers(this.session.client.rpcHandlerManager, {
            onAbort: () => this.handleAbort(),
            onSwitch: () => this.handleExitFromUi()
        })

        while (!this.shouldExit) {
            // Capture the signal per iteration (ported from dsh): handleAbort
            // swaps in a fresh AbortController right after aborting, so
            // re-reading this.abortController.signal below would see the
            // replacement (never aborted) and mistake an aborted wait for a
            // closed queue — breaking the loop and killing the whole session
            // on a Stop that arrived while the queue was idle. The captured
            // signal stays aborted forever, so the iteration continues and
            // re-waits on the fresh controller.
            const signal = this.abortController.signal
            const batch = await this.session.queue.waitForMessagesAndGetAsString(signal)
            if (!batch) {
                if (signal.aborted && !this.shouldExit) continue
                break
            }

            // A respawn that failed on an earlier batch leaves no backend
            // behind: rebuild before touching this batch (one fresh attempt
            // per message — a permanently down berry binary surfaces one
            // error per message instead of wedging the session).
            if (!this.backend) {
                const reconnected = await this.respawnBackend()
                if (!reconnected) {
                    if (this.session.queue.size() === 0 && !this.shouldExit) {
                        this.session.sendSessionEvent({ type: 'ready' })
                    }
                    continue
                }
                backend = reconnected.backend
                acpSessionId = reconnected.acpSessionId
            }

            // Display-only: read-only turns are still SENT — the HAPI
            // permission bridge classifies and denies write requests; there
            // is no agent-side sandbox switch that could fail and skip the
            // turn.
            this.applyDisplayMode(batch.mode.permissionMode)

            // No per-turn model handling: berry has no runtime model surface
            // (BERRY_AGENT_MODEL is spawn-time only), so a queued mode.model
            // — including the picker's null "Default" — is ignored instead of
            // being answered with a 'Cannot switch model' failure every turn.

            this.messageBuffer.addMessage(batch.message, 'user')
            // Image attachments are read once here (authorized per session)
            // and the built content is reused verbatim by the respawn retry,
            // so a reconnect never re-reads or re-orders the batch's images.
            // Per-image failures are handled inside (status notice + skip);
            // this guard only catches unexpected preparation errors so they
            // degrade to a text-only turn instead of killing the loop.
            let prompt: PromptContent[]
            try {
                prompt = await buildBerryPromptContent(
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
                logger.warn('[berry-acp] prompt preparation failed', { message })
                prompt = [{ type: 'text', text: batch.message }]
            }

            // Honor a Stop that landed after this batch left the queue.
            // Preparation is async (image reads) and the respawn rebuild
            // above can await too, so a user Stop can arrive before the
            // prompt is dispatched. handleAbort already reset the queue and
            // showed the user 'Session aborted' — but a batch that was
            // already dequeued is beyond the reset's reach, so dispatching
            // it would run a whole turn after the user believes it was
            // stopped. The iteration's captured signal stays aborted
            // forever (handleAbort swaps in a fresh controller), so it
            // witnesses every stop of this iteration: drop the prepared
            // prompt and settle the session back to idle instead.
            if (signal.aborted) {
                this.messageBuffer.addMessage('Aborted before dispatch; dropping the queued message', 'status')
                if (this.session.queue.size() === 0 && !this.shouldExit) {
                    this.session.sendSessionEvent({ type: 'ready' })
                }
                continue
            }

            // Thinking starts exactly when a turn is dispatched, so a batch
            // dropped by the gate above never flips the session into
            // thinking.
            this.session.onThinkingChange(true)
            try {
                await backend.prompt(acpSessionId, prompt, (message) => this.handleAgentMessage(message))
            } catch (error) {
                const respawned = this.shouldRespawnAfterPromptFailure(error)
                    ? await this.respawnBackend()
                    : null
                if (respawned) {
                    backend = respawned.backend
                    acpSessionId = respawned.acpSessionId
                    // The backend is rebuilt so the session (and the NEXT
                    // message) works again, but the failed batch is NOT
                    // automatically resubmitted: an indeterminate failure
                    // means the child closed with the request already
                    // dispatched and its outcome unknowable — the turn may
                    // have partially executed (non-idempotent actions
                    // included), and replaying the same instruction can
                    // repeat commands and side effects. Surface the
                    // uncertain outcome; the user re-sends to retry.
                    this.session.sendSessionEvent({
                        type: 'message',
                        message: 'Berry agent died mid-turn; the message may have partially run. Re-send it to retry.'
                    })
                    this.messageBuffer.addMessage('Berry agent died mid-turn — message not auto-retried; re-send to retry', 'status')
                } else {
                    this.reportPromptFailure(error)
                }
            } finally {
                this.session.onThinkingChange(false)
                await this.permissionHandler?.cancelAll('Prompt finished')
                if (this.session.queue.size() === 0 && !this.shouldExit) {
                    this.session.sendSessionEvent({ type: 'ready' })
                }
            }
        }
    }

    protected async cleanup(): Promise<void> {
        this.clearAbortHandlers(this.session.client.rpcHandlerManager)
        await this.permissionHandler?.cancelAll('Session ended')
        this.permissionHandler = null
        await this.backend?.disconnect()
        this.backend = null
    }

    /**
     * Establish an ACP session on `backend`: restore the persisted Berry
     * session id through `session/load` when the backend advertises
     * `agentCapabilities.loadSession`, otherwise (no persisted id,
     * unsupported, or load failure) start a fresh one. Shared by the
     * initial launch and the post-crash respawn.
     */
    private async establishAcpSession(
        backend: ReturnType<typeof createBerryBackend>
    ): Promise<string> {
        const resumeSessionId = this.session.sessionId
        if (resumeSessionId) {
            try {
                // Berry has NO session/resume — its resume path is
                // session/load (agentCapabilities.loadSession: replay the
                // full stored history, then live-attach). The replayed
                // history is suppressed so it never reaches the hub
                // transcript (the Hub stays the transcript source).
                if (!backend.supportsLoadSession()) {
                    throw new Error('Berry ACP server does not advertise session/load (agentCapabilities.loadSession)')
                }
                const sessionId = await backend.suppressUpdatesDuring(() =>
                    backend.loadSession({
                        sessionId: resumeSessionId,
                        cwd: this.session.path,
                        mcpServers: []
                    })
                )
                // Berry answers session/load with {} — AcpSdkBackend.loadSession
                // then falls back to the REQUESTED id (verified semantics), so
                // the persisted id is what both sides keep using.
                return sessionId || resumeSessionId
            } catch (error) {
                logger.warn('[berry-acp] session/load failed, starting a new session', error)
                this.session.sendSessionEvent({
                    type: 'message',
                    message: 'Berry session load failed; starting a new session.'
                })
            }
        }
        return backend.newSession({
            cwd: this.session.path,
            // The Berry ACP server configures its own tools; HAPI
            // does not bridge MCP servers for it in v1.
            mcpServers: []
        })
    }

    /**
     * Whether a failed prompt should trigger a backend respawn: only the
     * transport's typed indeterminate marker (child exited, transport
     * closed, failed stdin write — the request never reached a JSON-RPC
     * outcome) qualifies. A LIVE backend's ordinary JSON-RPC error must not
     * respawn, even when its text mentions "process exited" — an agent-side
     * error message saying so still leaves a healthy transport that would
     * serve the next turn. Never respawn while tearing down.
     */
    private shouldRespawnAfterPromptFailure(error: unknown): boolean {
        if (this.shouldExit) return false
        return isAcpIndeterminateError(error)
    }

    /**
     * Rebuild the ACP backend after its subprocess died mid-session. The
     * transport never comes back on its own — every later prompt on the dead
     * backend fails — so prompt-level recovery means: dispose the dead
     * backend, spawn a fresh one (same spawn-time model + dataDir levers),
     * re-establish the ACP session (loading the persisted Berry session id
     * when possible), and rebind the per-backend state (permission bridge,
     * model). Returns the new backend + session id, or null when the
     * respawn itself failed — the caller then reports the original prompt
     * error and the loop stays alive for the next turn.
     */
    private async respawnBackend(): Promise<{
        backend: ReturnType<typeof createBerryBackend>
        acpSessionId: string
    } | null> {
        this.session.sendSessionEvent({
            type: 'message',
            message: 'Berry agent process exited; restarting it.'
        })
        this.messageBuffer.addMessage('Berry agent exited — restarting', 'status')

        // The permission bridge is bound to the dead backend's transport;
        // cancel whatever is still pending through it before dropping it.
        const deadBackend = this.backend
        this.backend = null
        try {
            await this.permissionHandler?.cancelAll('Backend respawned')
        } catch (error) {
            logger.debug('[berry-acp] cancelAll during respawn failed', error)
        }
        this.permissionHandler = null
        try {
            await deadBackend?.disconnect()
        } catch (error) {
            logger.debug('[berry-acp] disconnect of dead backend failed', error)
        }

        try {
            const backend = this.spawnBackend()
            this.backend = backend
            await backend.initialize()
            const acpSessionId = await this.establishAcpSession(backend)
            this.session.onSessionFound(acpSessionId)

            // No model state to rebind: the spawn-time BERRY_AGENT_MODEL lever
            // rides spawnBackend itself (the fresh child re-applies it), and
            // berry has no runtime model RPC to re-assert.

            this.permissionHandler = new AcpPermissionHandler(
                this.session.client,
                backend,
                () => this.session.getPermissionMode() as PermissionMode | undefined,
                { sessionScopedPermissionGrants: true }
            )
            this.messageBuffer.addMessage('Berry agent restarted', 'status')
            return { backend, acpSessionId }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            logger.warn('[berry-acp] respawn failed', { message })
            // Dispose the half-built replacement: leaving it assigned would
            // make later prompts fail with the unmarked 'ACP transport not
            // initialized' error, which can never trigger recovery. With
            // this.backend null the next message re-enters the loop-top
            // reconnect and retries initialization.
            try {
                await this.backend?.disconnect()
            } catch (disconnectError) {
                logger.debug('[berry-acp] disconnect of failed replacement failed', disconnectError)
            }
            this.backend = null
            this.session.sendSessionEvent({
                type: 'message',
                message: `Berry agent restart failed: ${message}`
            })
            this.messageBuffer.addMessage(`Berry agent restart failed: ${message}`, 'status')
            return null
        }
    }

    private reportPromptFailure(error: unknown): void {
        const message = error instanceof Error ? error.message : String(error)
        logger.warn('[berry-acp] prompt failed', { message })
        this.session.sendSessionEvent({ type: 'message', message: `Berry prompt failed: ${message}` })
        this.messageBuffer.addMessage(`Berry prompt failed: ${message}`, 'status')
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
                this.messageBuffer.addMessage('Turn complete', 'status')
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

    /** Mirrors the effective permission mode into the terminal log so remote
     *  sessions show what the bridge will auto-approve (kimi-style). */
    private applyDisplayMode(permissionMode: PermissionMode | undefined): void {
        if (permissionMode && permissionMode !== this.displayPermissionMode) {
            this.displayPermissionMode = permissionMode
            this.messageBuffer.addMessage(`[MODE:${permissionMode}]`, 'system')
        }
    }

    private async handleAbort(): Promise<void> {
        // Tear the queue wait down synchronously, BEFORE any await (ported
        // from dsh): aborting (and replacing) the controller first unparks a
        // waiting loop iteration via its captured signal so it re-waits on
        // the fresh controller instead of dying, and resetting the queue
        // before the cancel requests go on the wire drops anything queued
        // ahead of the stop — the in-flight prompt can complete while
        // cancelPrompt is still pending, and the loop would otherwise
        // dequeue that already-aborted follow-up and run it after the user
        // saw "Session aborted".
        this.abortController.abort()
        this.abortController = new AbortController()
        this.session.queue.reset()
        if (this.backend && this.session.sessionId) {
            await this.backend.cancelPrompt(this.session.sessionId)
        }
        await this.permissionHandler?.cancelAll('User aborted')
        this.session.sendSessionEvent({ type: 'message', message: 'Session aborted' })
        this.session.onThinkingChange(false)
        this.messageBuffer.addMessage('Turn aborted', 'status')
    }

    private async handleExitFromUi(): Promise<void> {
        await this.requestExit('exit', () => this.handleAbort())
    }
}
