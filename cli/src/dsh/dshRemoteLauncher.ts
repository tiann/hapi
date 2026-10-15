import React from 'react'
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
import { createDshBackend } from './utils/dshBackend'
import type { DshSession } from './session'

export class DshRemoteLauncher extends RemoteLauncherBase {
    private backend: ReturnType<typeof createDshBackend> | null = null
    private permissionHandler: AcpPermissionHandler | null = null
    private abortController = new AbortController()
    /** Set when abort closed the ACP session (dsh has no cancel capability). */
    private acpSessionEnded = false
    /** In-flight abort; queued prompts await it so none races the session close. */
    private abortCompletion: Promise<void> | null = null
    /** Bumped at the top of every handleAbort; lets the respawn branch detect
     *  an abort that landed while the replacement session was being created. */
    private abortGeneration = 0

    constructor(private readonly session: DshSession) {
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
        const backend = createDshBackend()
        this.backend = backend
        backend.onStderrError((error) => {
            logger.debug('[dsh-acp] stderr error', error)
            this.session.sendSessionEvent({ type: 'message', message: error.message })
            this.messageBuffer.addMessage(error.message, 'status')
        })

        await backend.initialize()
        // Any close-path cancellation ends the ACP session — including the
        // permission handler's `abort` decision, which cancels through the
        // backend directly and never enters handleAbort. Track it centrally
        // so the next message always respawns the session.
        backend.onSessionClosedByCancel(() => {
            this.acpSessionEnded = true
        })
        let acpSessionId = await backend.newSession({
            cwd: this.session.path,
            // The official DSH ACP composition rejects non-empty MCP servers;
            // its tools are configured by the DSH server itself.
            mcpServers: []
        })
        this.session.sessionId = acpSessionId

        this.permissionHandler = new AcpPermissionHandler(
            this.session.client,
            backend,
            () => undefined,
            // Permission 'abort' decisions cancel through the backend directly
            // and never enter handleAbort: record the pending close here so the
            // main loop defers the next message until the session/close response
            // lands, exactly like a handleAbort-initiated close.
            (cancellation) => {
                this.abortCompletion ??= cancellation
            }
        )
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
            // lands while the dequeued batch waits for a pending close (or for
            // the respawn) resets the queue, but a batch already removed by
            // waitForMessagesAndGetAsString cannot be discarded that way — the
            // generation mismatch is what drops it.
            const generationAtDequeue = this.abortGeneration

            if (this.abortCompletion) {
                // An abort is closing (or just closed) the ACP session; let it
                // finish before dequeuing, so this message never targets the
                // session being closed nor skips the respawn branch.
                const pending = this.abortCompletion
                this.abortCompletion = null
                await pending
                if (generationAtDequeue !== this.abortGeneration) {
                    // A user stop landed while this batch waited for the pending
                    // close: the user saw 'Session aborted' and the queue was
                    // reset, so this already-dequeued message must not run on
                    // whatever session comes next.
                    this.messageBuffer.addMessage('Aborted while waiting for the DSH session close; dropping the queued message', 'status')
                    continue
                }
            }

            if (this.acpSessionEnded) {
                // Abort on dsh goes through session/close (no cancel capability),
                // which ends the ACP session but leaves the process alive —
                // start a fresh session so the next message keeps flowing.
                // Snapshot the abort generation: an abort landing while the
                // replacement session is being created targets the old session
                // id and must also discard the already-dequeued batch (the user
                // saw 'Session aborted').
                const generationBeforeRespawn = this.abortGeneration
                acpSessionId = await backend.newSession({
                    cwd: this.session.path,
                    mcpServers: []
                })
                this.session.sessionId = acpSessionId
                if (generationBeforeRespawn !== this.abortGeneration) {
                    // Aborted mid-recreation: drop the batch and treat the fresh
                    // session as ended so the next loop respawns cleanly instead
                    // of running a message the user aborted.
                    this.acpSessionEnded = true
                    this.messageBuffer.addMessage('Aborted while restarting the DSH session; dropping the queued message', 'status')
                    continue
                }
                this.acpSessionEnded = false
                this.messageBuffer.addMessage('DSH session restarted after abort', 'status')
            }

            this.session.onThinkingChange(true)
            this.messageBuffer.addMessage(batch.message, 'user')
            const prompt: PromptContent[] = [{ type: 'text', text: batch.message }]
            try {
                await backend.prompt(acpSessionId, prompt, (message) => this.handleAgentMessage(message))
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                logger.warn('[dsh-acp] prompt failed', { message })
                this.session.sendSessionEvent({ type: 'message', message: `DSH prompt failed: ${message}` })
                this.messageBuffer.addMessage(`DSH prompt failed: ${message}`, 'status')
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

    private handleAgentMessage(message: AgentMessage): void {
        const converted = convertAgentMessage(message)
        if (converted) this.session.sendAgentMessage(converted)

        switch (message.type) {
            case 'text':
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
                break
            default: {
                const _exhaustive: never = message
                return _exhaustive
            }
        }
    }

    private async handleAbort(): Promise<void> {
        // Bump first, synchronously: the respawn branch compares generations
        // around its `await backend.newSession(...)` to detect aborts that
        // land inside that window.
        this.abortGeneration += 1
        // Tear the queue down synchronously, BEFORE awaiting the close: the
        // in-flight prompt can complete while the close request is still on
        // the wire, and the loop would then dequeue a follow-up queued before
        // the stop with an already-incremented generation — the dequeue-site
        // generation check cannot catch that ordering, and a reset scheduled
        // after the await is too late. Aborting (and replacing) the controller
        // first also unparks a waiting loop iteration via the captured signal
        // so it re-waits on the fresh controller instead of spinning on the
        // aborted one.
        this.abortController.abort()
        this.abortController = new AbortController()
        this.session.queue.reset()
        // Record the abort synchronously: the main loop awaits
        // abortCompletion before dequeuing the next message.
        this.abortCompletion ??= this.closeSessionForAbort()
        await this.abortCompletion
        await this.permissionHandler?.cancelAll('User aborted')
        this.session.sendSessionEvent({ type: 'message', message: 'Session aborted' })
        this.session.onThinkingChange(false)
        this.messageBuffer.addMessage('Turn aborted', 'status')
    }

    private async closeSessionForAbort(): Promise<void> {
        if (this.backend && this.session.sessionId) {
            await this.backend.cancelPrompt(this.session.sessionId)
            // The onSessionClosedByCancel listener owns acpSessionEnded for
            // every close-path cancellation; nothing to do here on the
            // session/cancel path, which keeps the session alive.
        }
    }

    private async handleExitFromUi(): Promise<void> {
        await this.requestExit('exit', () => this.handleAbort())
    }
}
