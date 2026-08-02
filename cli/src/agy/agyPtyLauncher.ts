import React from "react"
import { AgySession } from "./session"
import { RemoteModeDisplay } from "@/ui/ink/RemoteModeDisplay"
import { agyPty } from "./agyPty"
import { createAgySessionScanner } from "./utils/agySessionScanner"
import type { AgyToolCall } from "./utils/agyTranscriptTypes"
import { isAgyAskQuestionToolCall, buildCanonicalAskUserQuestionInput, type AgyAskQuestionQuestion } from "./utils/agyAskQuestion"
import { buildAgyQuestionKeys } from "./utils/agyQuestionKeys"
import { logger } from "@/ui/logger"
import {
    RemoteLauncherBase,
    type RemoteLauncherDisplayContext,
    type RemoteLauncherExitReason,
    type LaunchOutcome
} from "@/modules/common/remote/RemoteLauncherBase"

// Transcript entry types that agy inserts as meta (not tool results): they must
// NOT consume a pending tool_call invocation, or the FIFO pairing drifts and the
// real tool actions in the same planner batch get mis-labeled.
const AGY_NON_TOOL_ACTION_TYPES = new Set(['ERROR_MESSAGE', 'SYSTEM_MESSAGE'])

class AgyPtyLauncher extends RemoteLauncherBase {
    private readonly session: AgySession
    private scanner: any = null
    private firstMessageSent = false
    // The agy brain UUID for the current conversation. Set from the pre-known
    // resume ID (if this is a resume) or discovered via the scanner's content-
    // match once the first user message appears in the brain transcript.
    // Persisted here so re-spawns (crash recovery) resume the same conversation.
    private agySessionId: string | null = null
    // Live PTY controls (raw keystroke injection) for turn-interrupt
    private ptyControls: { sendKeys: (data: string) => void } | null = null
    // Tool calls (name + args) from the most recent PLANNER_RESPONSE, awaiting
    // pairing with the action entries that follow it. agy splits a tool
    // invocation (on the planner step) from its result (the action entry), so
    // this FIFO lets each action entry recover its input for the chat tool card.
    private pendingAgyToolCalls: AgyToolCall[] = []

    protected getCurrentSessionId(): string | null {
        return this.session.sessionId
    }

    constructor(session: AgySession) {
        super(process.env.DEBUG ? session.logPath : undefined)
        this.session = session
        // If the session already carries an agySessionId (passed in from the
        // hub on resume), pre-seed it so the first spawn can --conversation to it.
        this.agySessionId = session.sessionId
        session.setKillHandler(() => this.abort())
    }

    protected createDisplay(context: RemoteLauncherDisplayContext): React.ReactElement {
        return React.createElement(RemoteModeDisplay, context)
    }

    private async abort(): Promise<void> {
        if (this.ptyAbortController && !this.ptyAbortController.signal.aborted) {
            this.ptyAbortController.abort()
        }
    }

    private async handleAbortRequest(): Promise<void> {
        logger.debug('[agy-pty]: handleAbortRequest (interrupt)')
        // Finding F1 (hostile-review): the interrupt kills the in-flight turn
        // but leaves any pending ask_question request unresolved. Phase 0
        // measured that agy has no way to recover the answered-selector state
        // after an interrupt, so a stale web answer arriving afterward must
        // never be injected as keystrokes into whatever is now on screen —
        // invalidate the pending question(s) up front.
        this.session.agyPermissionHandler?.cancelPendingQuestions('Turn aborted before the question was answered')
        if (this.ptyControls) {
            logger.debug('[agy-pty]: Sending interrupt key (Ctrl-C) to PTY')
            this.ptyControls.sendKeys('\x03')
        } else {
            logger.debug('[agy-pty]: No PTY controls active, falling back to aborting the controller')
            await this.abort()
        }
    }

    /**
     * agy's native `ask_question` never goes through the PreToolUse hook (it's
     * a pure TUI interaction with no side effect to gate — see
     * agyPermissionHandler's docstring), so this is the ONLY place that ever
     * sees it: registers it as a pending request (surfacing a question card in
     * the web chat via the same agentState.requests/`permission` RPC machinery
     * every other tool approval uses) and, once answered, builds the raw PTY
     * key sequence and injects it into the already-rendered TUI selector.
     */
    private handleAskQuestion(toolCall: AgyToolCall, stepIndex: number | undefined, callIndex: number): void {
        const handler = this.session.agyPermissionHandler
        if (!handler) {
            logger.debug('[agy-pty]: ask_question seen but no agyPermissionHandler is wired (non-PTY mode?)')
            return
        }

        const canonical = buildCanonicalAskUserQuestionInput(toolCall.args)
        if (canonical.questions.length === 0) {
            logger.debug('[agy-pty]: ask_question tool_call had no parseable questions; skipping')
            return
        }

        // Keyed like the paired-action toolUseId (conversationId:stepIdx), plus
        // callIndex so two ask_question calls in the same planner batch (not
        // observed in practice, but not provably impossible) never collide.
        const toolUseId = this.agySessionId
            ? `${this.agySessionId}:${stepIndex ?? 'unknown'}:ask${callIndex}`
            : `local:${stepIndex ?? 'unknown'}:ask${callIndex}:${Date.now()}`

        const questions: AgyAskQuestionQuestion[] = canonical.questions
        handler.registerQuestionRequest(toolUseId, canonical)
            .then((answers) => {
                const keys = buildAgyQuestionKeys(questions, answers)
                if (keys) {
                    this.ptyControls?.sendKeys(keys)
                }
            })
            .catch((err) => {
                logger.debug('[agy-pty]: ask_question pending request failed/canceled', { err })
            })
    }

    private async handleSwitchRequest(): Promise<void> {
        logger.debug('[agy-pty]: doSwitch')
        await this.requestExit('switch', async () => {
            await this.abort()
        })
    }

    private async handleExitFromUi(): Promise<void> {
        logger.debug('[agy-pty]: Exiting via Ctrl-C')
        await this.requestExit('exit', async () => {
            await this.abort()
        })
    }

    private async handleSwitchFromUi(): Promise<void> {
        logger.debug('[agy-pty]: Switching to local mode via double space')
        await this.handleSwitchRequest()
    }

    public async launch(): Promise<RemoteLauncherExitReason> {
        return this.start({
            onExit: () => this.handleExitFromUi(),
            onSwitchToLocal: () => this.handleSwitchFromUi()
        })
    }

    protected async launchOnce(signal: AbortSignal): Promise<LaunchOutcome> {
        let reachedReady = false
        let authFailedThisRound = false
        try {
            await agyPty({
                sessionId: this.session.sessionId,
                path: this.session.path,
                agyEnvVars: undefined,
                agyArgs: ['--dangerously-skip-permissions'],
                // Resume an existing brain conversation if we have the UUID.
                resumeSessionId: this.agySessionId ?? undefined,
                // Launch with the session's current model so a picked model actually takes effect.
                model: this.session.getModel() ?? undefined,
                hookCarrierDir: this.session.hookCarrierDir,
                hookPort: this.session.hookPort,
                hookToken: this.session.hookToken,
                signal,
                nextMessage: async () => {
                    const msg = await this.session.queue.waitForMessagesAndGetAsString(signal)
                    if (!msg) return null
                    if (!this.firstMessageSent) {
                        this.firstMessageSent = true
                        if (!this.agySessionId) {
                            this.scanner.setSessionMessageText(msg.message)
                        }
                    }
                    return { message: msg.message }
                },
                registerControls: (controls) => {
                    this.ptyControls = controls
                    this.session.client.resetAgentTerminal()
                    this.session.client.setAgentTerminalControls(controls)
                },
                onAuthFailure: () => {
                    authFailedThisRound = true
                    logger.debug(`[agy-pty]: auth failure (keyring timeout)`)
                },
                onReady: () => {
                    reachedReady = true
                    logger.debug('[agy-pty]: agy PTY ready')
                    this.session.client.sendSessionEvent({ type: 'ready' })
                },
                onMessage: (data: string) => {
                    if (process.env.DEBUG_PTY) {
                        logger.debug(`[agy-pty:onMessage] received ${data.length} bytes`)
                    }
                    this.session.client.emitAgentTerminalOutput(data)
                    if (!this.agySessionId) {
                        const discovered = this.scanner.getBrainUuid()
                        if (discovered) {
                            logger.debug(`[agy-pty]: brain UUID discovered: ${discovered}`)
                            this.agySessionId = discovered
                            this.session.onSessionFound(discovered)
                        }
                    }
                },
                onThinkingChange: (thinking: boolean) => {
                    this.session.onThinkingChange(thinking)
                },
                onExit: (code: number | null) => {
                    logger.debug(`[agy-pty]: agy PTY exited with code ${code}`)
                    this.ptyControls = null
                    // Finding F1 (hostile-review): a respawn (runRespawnLoop)
                    // establishes a brand-new PTY/selector — Phase 0 measured
                    // that `agy --conversation <uuid>` resume does NOT restore
                    // a pending ask_question TUI, it lands on a plain idle
                    // prompt. Without this, a stale web answer that resolves
                    // AFTER the respawn would inject keys into that idle
                    // prompt (or a fresh turn) on the NEW PTY generation.
                    // Invalidating on every exit (not just final teardown)
                    // closes that window and also resolves the web's question
                    // card instead of leaving it pending forever.
                    this.session.agyPermissionHandler?.cancelPendingQuestions('agy PTY exited while a question was pending')
                    if (authFailedThisRound) return
                    this.session.client.sendSessionEvent({
                        type: 'message',
                        message: `Process exited with code ${code}`
                    })
                },
            })

            if (!this.exitReason && signal.aborted) {
                this.session.client.sendSessionEvent({ type: 'message', message: 'Aborted by user' })
            }

            return { reachedReady, authFailed: authFailedThisRound }
        } catch (e) {
            return { reachedReady, authFailed: authFailedThisRound, error: e instanceof Error ? e : new Error(String(e)) }
        }
    }

    protected async runMainLoop(): Promise<void> {
        logger.debug('[agyPtyLauncher] Starting PTY launcher')

        const session = this.session
        const messageBuffer = this.messageBuffer

        this.setupAbortHandlers(session.client.rpcHandlerManager, {
            onAbort: () => this.handleAbortRequest(),
            onSwitch: () => this.handleSwitchRequest()
        })

        const resumeBrainUuid = this.agySessionId ?? undefined
        this.scanner = await createAgySessionScanner({
            resumeBrainUuid,
            onBrainFound: (uuid) => {
                if (!this.agySessionId) {
                    logger.debug(`[agy-pty]: brain UUID discovered via onBrainFound: ${uuid}`)
                    this.agySessionId = uuid
                    session.onSessionFound(uuid)
                }
            },
            onEntry: (entry) => {
                if (entry.type === 'USER_INPUT') return
                const hasText = (entry.content ?? '').trim().length > 0
                const hasToolCalls = (entry.tool_calls?.length ?? 0) > 0
                if (!hasText && !hasToolCalls) return
                if (entry.type === 'PLANNER_RESPONSE') {
                    // A planner step declares the tool CALLS (name + args) for the
                    // action entries that immediately follow it — one per call, in
                    // order (see agySessionScanner ordering). Buffer them so each
                    // following action entry can be paired with its invocation; the
                    // planner itself renders as the agent's prose (agy_message).
                    //
                    // ask_question is excluded from this buffer: it is agy's native
                    // TUI selector, never followed by a paired action/result entry
                    // (Phase 0 measurement, 2026-07-10 — see the question-wiring
                    // plan), so nothing would ever shift() it out. Leaving it in
                    // would let a LATER, unrelated action entry incorrectly consume
                    // it via shift() and mis-pair its tool card. Handle it via its
                    // own side channel instead (handleAskQuestion).
                    const allToolCalls = entry.tool_calls ?? []
                    this.pendingAgyToolCalls = allToolCalls.filter((tc) => !isAgyAskQuestionToolCall(tc))
                    allToolCalls.forEach((toolCall, callIndex) => {
                        if (isAgyAskQuestionToolCall(toolCall)) {
                            // callIndex disambiguates the (unobserved in practice, but
                            // not impossible) case of more than one ask_question call
                            // in the same planner batch — without it both would
                            // compute the same toolUseId and collide in agentState.
                            this.handleAskQuestion(toolCall, entry.step_index, callIndex)
                        }
                    })
                    session.client.sendAgySessionMessage(entry, this.agySessionId ?? undefined)
                    return
                }
                // Action entry (RUN_COMMAND, VIEW_FILE, …): its `content` is the
                // result. Pop the matching invocation (FIFO) so the tool card shows
                // the input (command/path/args) instead of just the raw result.
                // BUT skip meta entries (ERROR_MESSAGE / SYSTEM_MESSAGE): agy
                // interleaves those into a planner batch without a corresponding
                // tool_call, so consuming one here would shift the FIFO and mis-pair
                // every real action that follows in the same batch.
                const toolCall = AGY_NON_TOOL_ACTION_TYPES.has(entry.type)
                    ? undefined
                    : this.pendingAgyToolCalls.shift()
                session.client.sendAgySessionMessage(entry, this.agySessionId ?? undefined, toolCall)
            }
        })

        // Bridge the OTHER brain-UUID discovery path (the PreToolUse hook, via
        // runAgy.ts:onPreToolUse -> wrapper.onSessionFound) into the scanner.
        // Previously that path only updated session metadata (see the comment
        // there) and never notified the scanner, so a session whose scanner
        // content-match failed (e.g. a first message with attachments — see
        // agySessionScanner.test.ts) never started tailing even though the hook
        // had already discovered the UUID: the chat stayed empty. Both discovery
        // paths funnel through AgentSessionBase.onSessionFound, so registering
        // here covers hook discovery AND is idempotent with the onBrainFound
        // self-loop above (scanner.onNewSession no-ops on an unchanged UUID).
        // Also persist agySessionId here through the session state callback;
        // handleSessionFound) so a crash/respawn in the narrow window between
        // the hook firing and the next PTY output chunk (which is the only other
        // writer, via onMessage's getBrainUuid() fallback) still resumes the same
        // brain conversation via --conversation instead of silently starting a
        // fresh one.
        const handleSessionFound = (uuid: string) => {
            this.agySessionId = uuid
            this.scanner?.onNewSession(uuid)
        }
        session.addSessionFoundCallback(handleSessionFound)

        try {
            this.firstMessageSent = false
            await this.runRespawnLoop({
                maxAuthRetries: 8,
                authRetryDelayMs: 1500,
                onLaunchStart: (isNewSession) => {
                    messageBuffer.addMessage('═'.repeat(40), 'status')
                    if (this.agySessionId) {
                        messageBuffer.addMessage('Resuming agy PTY session...', 'status')
                    } else {
                        messageBuffer.addMessage('Starting agy PTY session...', 'status')
                    }
                },
                launchOnce: (sig) => this.launchOnce(sig),
                onLaunchFailure: (err) => {
                    if (err.message.includes('Authentication failed')) {
                        session.client.sendSessionEvent({
                            type: 'message',
                            message: `agy failed to authenticate after 8 attempts (keyring timeout). Ensure the login keyring is unlocked.`
                        })
                    } else {
                        session.client.sendSessionEvent({ type: 'message', message: err.message })
                    }
                }
            })
        } finally {
            session.client.setAgentTerminalControls(null)
            session.removeSessionFoundCallback(handleSessionFound)
            if (this.scanner) {
                await this.scanner.cleanup()
                this.scanner = null
            }
            logger.debug('[agy-pty]: main loop ended')
        }
    }

    protected async cleanup(): Promise<void> {
        this.clearAbortHandlers(this.session.client.rpcHandlerManager)
        logger.debug('[agy-pty]: cleanup done')
    }
}

export async function agyPtyLauncher(session: AgySession): Promise<'switch' | 'exit'> {
    const launcher = new AgyPtyLauncher(session)
    return launcher.launch()
}
