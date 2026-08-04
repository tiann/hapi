import React from "react"
import { AgySession } from "./session"
import { RemoteModeDisplay } from "@/ui/ink/RemoteModeDisplay"
import { agyPty } from "./agyPty"
import { createAgySessionScanner, extractBodyText, extractUserRequest, normalizeUserInput } from "./utils/agySessionScanner"
import type { AgyToolCall } from "./utils/agyTranscriptTypes"
import { isAgyAskQuestionToolCall, buildCanonicalAskUserQuestionInput, type AgyAskQuestionQuestion } from "./utils/agyAskQuestion"
import { buildAgyQuestionKeys } from "./utils/agyQuestionKeys"
import { buildAgyModelNavigationKeys, buildAgyModelPickerTarget, findAgyCurrentModelRow } from './utils/agyModelKeys'
import { agyHookCarrierIsIntact, prepareAgyHookCarrier, writeAgyHooksJsonAtomic } from './utils/agyHookCarrier'
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
const QUOTA_DETECTOR_RAW_TAIL_SIZE = 8 * 1024
const QUOTA_ANCHOR = 'Individual quota reached. Please upgrade your subscription to increase your limits.'
const QUOTA_SCREEN_CONTEXT = "How's the CLI experience so far? Help us improve:"

// Brain-UUID discovery (see runAgy.ts's PreToolUse/PreInvocation hooks) is
// the only way this launcher learns the agy conversation ID; there is no
// content-matching fallback anymore. If a model call has actually started
// (see the onThinkingChange wiring below — NOT just "the PTY is ready",
// which fires the moment the prompt is usable and says nothing about a
// model having been invoked yet) and neither hook has fired within this
// window (bridge misconfigured, hooks.json didn't load, future agy version
// drops the field, ...), the web chat would otherwise sit silently empty
// forever with no explanation other than the terminal mirror. 60s
// comfortably covers the latency to a model's first response (and thus the
// first PreInvocation/PreToolUse hook firing) without leaving the user in
// the dark for an excessive stretch if discovery is genuinely broken.
const DISCOVERY_TIMEOUT_MS = 60_000

function stripTerminalControlSequences(raw: string): string {
    let clean = ''
    for (let index = 0; index < raw.length; index += 1) {
        const character = raw[index]
        if (character === '\x1b') {
            const next = raw[index + 1]
            if (next === '[') {
                let end = index + 2
                while (end < raw.length && (raw.charCodeAt(end) < 0x40 || raw.charCodeAt(end) > 0x7e)) end += 1
                if (end >= raw.length) break
                index = end
                continue
            }
            if (next === ']') {
                let end = index + 2
                while (end < raw.length) {
                    if (raw[end] === '\x07') break
                    if (raw[end] === '\x1b' && raw[end + 1] === '\\') {
                        end += 1
                        break
                    }
                    end += 1
                }
                if (end >= raw.length) break
                index = end
                continue
            }
            index += next === undefined ? 0 : 1
            continue
        }
        if (character < ' ' || character === '\x7f') continue
        clean += character
    }
    return clean
}

function quotaResetDuration(cleanOutput: string): string | null {
    const match = /\bResets in\s+(.{1,64}?)(?=\.\s*(?:Error ID:|How's the CLI experience|\? for shortcuts)|$)/i.exec(cleanOutput)
    if (!match) return null
    const duration = match[1].trim()
    return /^[A-Za-z0-9:._ -]+$/.test(duration) ? duration : null
}

type PendingWebDelivery = {
    message: string
    localIds: string[]
    submitted: boolean
    observedBeforeSubmit: string | null
}

function parseAttachmentMessage(text: string, separator: '\n\n' | '\n'): {
    paths: string[]
    body: string
} | null {
    const separatorIndex = text.indexOf(separator)
    if (separatorIndex === -1) return null
    const prefix = text.slice(0, separatorIndex)
    if (!/^@\S+( @\S+)*$/.test(prefix)) return null
    return {
        paths: prefix.split(' ').sort(),
        body: text.slice(separatorIndex + separator.length),
    }
}

export function userRequestMatches(message: string, content: string): boolean {
    const request = extractUserRequest(content)
    if (request === null) return false
    const body = extractBodyText(message)
    // Attachment-only input carries no distinguishing text, so it stays fail-closed
    // ahead of the normalized compare below.
    if (!body) return false
    // Normalize exactly like the scanner's discovery match, so the two paths
    // cannot disagree over a CRLF or trailing whitespace.
    if (normalizeUserInput(request) === normalizeUserInput(message)) return true
    if (body === message) return false
    const sentAttachment = parseAttachmentMessage(message, '\n\n')
    const observedAttachment = parseAttachmentMessage(request, '\n')
    if (!sentAttachment || !observedAttachment) return false
    return sentAttachment.body === observedAttachment.body
        && sentAttachment.paths.length === observedAttachment.paths.length
        && sentAttachment.paths.every((path, index) => path === observedAttachment.paths[index])
}

class AgyPtyLauncher extends RemoteLauncherBase {
    private readonly session: AgySession
    private scanner: any = null
    // The agy brain UUID for the current conversation. Set from the pre-known
    // resume ID (if this is a resume) or adopted via handleSessionFound, which
    // is fed by agy's PreToolUse/PreInvocation hook (see
    // runAgy.ts:onPreToolUse/onAgyPreInvocation -> wrapper.onSessionFound).
    // Persisted here so re-spawns (crash recovery) resume the same conversation.
    private agySessionId: string | null = null
    // Live PTY controls (raw keystroke injection) for turn-interrupt
    private ptyControls: { sendKeys: (data: string) => void; invalidateInputReady: () => void } | null = null
    private agentRunInProgress = false
    private agentRunReserved = false
    private ptyGeneration = 0
    private questionInteractionEpoch = 0
    private interactionTail: Promise<void> = Promise.resolve()
    private outputWaiter: { expected: string; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null
    private recentOutput = ''
    // Separate from recentOutput: the model-picker watcher resets its own tail
    // around picker navigation, while quota detection is scoped to an agent run.
    private quotaDetectorRawTail = ''
    private quotaDetectorArmed = false
    private quotaReportedForCurrentRun = false
    // Tool calls (name + args) from the most recent PLANNER_RESPONSE, awaiting
    // pairing with the action entries that follow it. agy splits a tool
    // invocation (on the planner step) from its result (the action entry), so
    // this FIFO lets each action entry recover its input for the chat tool card.
    private pendingAgyToolCalls: AgyToolCall[] = []
    private pendingWebDelivery: PendingWebDelivery | null = null
    private pendingWebDeliveryResolved: (() => void) | null = null
    private activeWebPrompt: string | null = null
    // One-shot "discovery never happened" warning. Armed on the first real
    // evidence a model call is in flight (onThinkingChange(true) — NOT PTY
    // ready, which only means the prompt can accept keystrokes and can sit
    // idle for as long as the user likes with no discovery failure at all)
    // and disarmed the moment a brain UUID is adopted or the session tears
    // down — never rearmed, so a respawn cannot re-trigger it and a stale
    // timer cannot fire (or leak) after the launcher is done.
    private discoveryTimeoutTimer: ReturnType<typeof setTimeout> | null = null
    private discoveryTimeoutFired = false

    private armDiscoveryTimeoutWarning(): void {
        if (this.agySessionId || this.discoveryTimeoutFired || this.discoveryTimeoutTimer) return
        this.discoveryTimeoutTimer = setTimeout(() => {
            this.discoveryTimeoutTimer = null
            if (this.agySessionId || this.discoveryTimeoutFired) return
            this.discoveryTimeoutFired = true
            logger.warn(`[agy-pty]: brain UUID not discovered within ${DISCOVERY_TIMEOUT_MS}ms of the first model call; notifying the web chat`)
            this.session.client.sendSessionEvent({
                type: 'error',
                message: 'Antigravity conversation could not be identified — continue in the terminal.',
            })
        }, DISCOVERY_TIMEOUT_MS)
    }

    private clearDiscoveryTimeoutWarning(): void {
        if (this.discoveryTimeoutTimer) {
            clearTimeout(this.discoveryTimeoutTimer)
            this.discoveryTimeoutTimer = null
        }
    }

    // PreInvocation fires on EVERY model call (measured ~424ms round trip,
    // see the agy-preinvocation-discovery plan §6.5 Gate 3) but is only
    // useful until the brain UUID is confirmed — after that every firing is
    // pure waste. agy re-reads hooks.json before every model call (§6.6), so
    // dropping the PreInvocation block from the SAME running carrier makes
    // that waste disappear immediately, without restarting agy. PreToolUse
    // is left untouched — the permission bridge is needed for the rest of
    // the session. Fail-open: if the write fails, PreInvocation just keeps
    // firing (harmless overhead), which is why this is a best-effort
    // try/catch rather than something that can abort the session.
    private detachPreInvocationHook(): void {
        const carrierDir = this.session.hookCarrierDir
        const withoutDiscovery = this.session.hooksJsonWithoutPreInvocation
        if (!carrierDir || !withoutDiscovery) return
        try {
            writeAgyHooksJsonAtomic(carrierDir, withoutDiscovery)
            logger.debug('[agy-pty]: brain UUID confirmed; dropped the now-redundant PreInvocation discovery hook')
        } catch (error) {
            logger.debug('[agy-pty]: failed to drop the PreInvocation hook after discovery (harmless — it will keep firing)', error)
        }
    }

    // Restores (or keeps dropped) the PreInvocation block right before every
    // launch — called from onLaunchStart, which — per
    // RemoteLauncherBase.runRespawnLoop — runs synchronously before each
    // launchOnce, including the very first one.
    //
    // Fix N1: which variant gets written depends on whether the brain UUID
    // is ALREADY known (this.agySessionId set — either seeded by a resume,
    // per the constructor, or adopted earlier via handleSessionFound). If it
    // is, PreInvocation is redundant and WITHOUT is written (or kept) —
    // there is no discovery left to do, so there is nothing to arm. This is
    // what makes a resumed session detach on its very first launch (previously
    // it never detached at all: handleSessionFound only runs off
    // addSessionFoundCallback, which is registered by run() AFTER
    // loop.ts's session.onSessionFound(resumeSessionId) has already fired
    // and already set this.agySessionId, so the callback that would have
    // triggered detachPreInvocationHook never sees that resume) and what
    // keeps a respawn from re-arming PreInvocation once discovery already
    // succeeded (previously onLaunchStart wrote WITH unconditionally on
    // every round, undoing detachPreInvocationHook's work the moment a
    // respawn happened — see agyPtyLauncher.test.ts's Phase 2.7 suite).
    //
    // If the UUID is NOT yet known, WITH is written (or kept) so discovery
    // can still happen on this launch. Resume-failure detection (a resume
    // silently starting a brand-new, unknown-UUID conversation) is out of
    // scope here — see Fix N2's docstring on why.
    //
    // If the carrier itself is gone (e.g. /tmp's 30-day tmpfiles.d sweep on
    // a long-lived session, §9), it is rebuilt from scratch via
    // prepareAgyHookCarrier and hookCarrierDir is repointed so the next agy
    // spawn's --add-dir uses it.
    // Fail-closed contract note: launchOnce always spawns agy with
    // --dangerously-skip-permissions (see its agyArgs above) — the carrier's
    // PreToolUse hook is the ONLY thing standing between that and agy
    // auto-approving every tool call with no user in the loop. runAgy.ts's
    // initial prepareAgyHookCarrier() failure already honors this by
    // aborting the session outright ("agy PTY session aborted: could not
    // prepare the hook carrier...") rather than starting unprotected. This
    // function is the respawn-time counterpart of that same carrier, so a
    // recreation failure here must carry the identical consequence: abort,
    // never spawn.
    private syncPreInvocationHookForLaunch(): void {
        const withDiscovery = this.session.hooksJsonWithPreInvocation
        const withoutDiscovery = this.session.hooksJsonWithoutPreInvocation
        if (!withDiscovery || !withoutDiscovery) return
        const desired = this.agySessionId ? withoutDiscovery : withDiscovery
        const carrierDir = this.session.hookCarrierDir
        if (!carrierDir || !agyHookCarrierIsIntact(carrierDir)) {
            const recreated = prepareAgyHookCarrier(desired, this.session.hookMcpServer)
            if (!recreated) {
                // Fix 1 (fail-closed): previously this just logged and
                // returned, letting onLaunchStart finish normally and
                // launchOnce spawn agy anyway — with no carrier at all, i.e.
                // no PreToolUse hook, i.e. every tool call auto-approved
                // with --dangerously-skip-permissions and nobody in the
                // loop. Throwing here instead propagates out of
                // onLaunchStart (called synchronously, before launchOnce,
                // by RemoteLauncherBase.runRespawnLoop — see its call site)
                // and aborts the respawn loop before agy is ever spawned.
                // sendSessionEvent first: the throw alone would otherwise
                // surface to the user only as an abrupt, unexplained session
                // end (runAgy.ts's catch -> markCrash logs to the debug log,
                // not the web chat) — mirrors the discovery-timeout warning
                // above (armDiscoveryTimeoutWarning), the existing mechanism
                // for "something silent broke, tell the web chat why."
                logger.debug('[agy-pty]: failed to recreate the hook carrier before respawn; aborting rather than spawning agy without a permission bridge (fail-closed)')
                this.session.client.sendSessionEvent({
                    type: 'error',
                    message: 'agy session aborted: could not recreate the permission bridge (hook carrier). Check that HAPI_HOME (default: ~/.hapi) is writable and has sufficient space.',
                })
                throw new Error(
                    'agy PTY session aborted: could not recreate the hook carrier needed for the permission bridge. ' +
                    'Check that HAPI_HOME (default: ~/.hapi) is writable and has sufficient space.'
                )
            }
            this.session.setHookCarrierDir(recreated.carrierDir)
            logger.debug(`[agy-pty]: hook carrier was missing before a respawn; recreated at ${recreated.carrierDir}`)
            return
        }
        try {
            writeAgyHooksJsonAtomic(carrierDir, desired)
        } catch (error) {
            // Unlike the recreation branch above, this stays fail-open
            // (log-and-continue) on purpose: agyHookCarrierIsIntact() just
            // confirmed carrierDir/.agents/hooks.json exists on disk with
            // SOME prior content (either prepareAgyHookCarrier's original
            // write or an earlier successful call to this same function) —
            // the permission bridge (PreToolUse) that content registers is
            // still in force either way. A failed overwrite here (ENOSPC, a
            // permission change mid-session, ...) only risks the
            // PreInvocation discovery block being stale (armed when it
            // should have been dropped, or vice versa) — a discovery
            // latency/overhead problem, never an unprotected-tool-call one.
            // That is not worth aborting a session over.
            logger.debug('[agy-pty]: failed to sync the PreInvocation hook state before respawn', error)
        }
    }

    private waitForPendingWebDelivery(signal: AbortSignal): Promise<void> {
        if (!this.pendingWebDelivery) return Promise.resolve()
        return new Promise((resolve) => {
            const finish = () => {
                signal.removeEventListener('abort', finish)
                if (this.pendingWebDeliveryResolved === finish) this.pendingWebDeliveryResolved = null
                resolve()
            }
            this.pendingWebDeliveryResolved = finish
            signal.addEventListener('abort', finish, { once: true })
        })
    }

    private finishPendingWebDelivery(): void {
        this.pendingWebDelivery = null
        const resolve = this.pendingWebDeliveryResolved
        this.pendingWebDeliveryResolved = null
        resolve?.()
    }

    private observeUserInput(content: string): boolean {
        const pending = this.pendingWebDelivery
        if (!pending || !userRequestMatches(pending.message, content)) return false
        if (!pending.submitted) {
            pending.observedBeforeSubmit = content
            return true
        }
        this.session.client.emitMessagesConsumed(pending.localIds)
        this.finishPendingWebDelivery()
        return true
    }

    private markWebDeliverySubmitted(): void {
        const pending = this.pendingWebDelivery
        if (!pending) return
        pending.submitted = true
        const observed = pending.observedBeforeSubmit
        pending.observedBeforeSubmit = null
        if (observed !== null) this.observeUserInput(observed)
    }

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
        const prompt = this.activeWebPrompt
        this.activeWebPrompt = null
        if (prompt !== null) {
            this.session.client.sendSessionEvent({ type: 'abort-restore', text: prompt })
        }
        this.questionInteractionEpoch += 1
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
        const interactionEpoch = this.questionInteractionEpoch
        handler.registerQuestionRequest(toolUseId, canonical)
            .then((answers) => {
                const keys = buildAgyQuestionKeys(questions, answers)
                if (keys) {
                    void this.enqueuePtyInteraction(
                        async () => { this.ptyControls?.sendKeys(keys) },
                        () => interactionEpoch === this.questionInteractionEpoch,
                    )
                }
            })
            .catch((err) => {
                logger.debug('[agy-pty]: ask_question pending request failed/canceled', { err })
            })
    }

    private enqueuePtyInteraction(
        task: () => Promise<void>,
        isCurrent: () => boolean = () => true,
        staleError?: string,
    ): Promise<void> {
        const result = this.interactionTail.then(async () => {
            if (!isCurrent()) {
                if (staleError) throw new Error(staleError)
                return
            }
            this.ptyControls?.invalidateInputReady()
            await task()
        })
        this.interactionTail = result.catch(() => {})
        return result
    }

    private waitForOutput(expected: string, timeoutMs = 5000): Promise<void> {
        if (this.outputWaiter) return Promise.reject(new Error('Another AGY output watcher is active'))
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                if (this.outputWaiter?.expected === expected) this.outputWaiter = null
                reject(new Error(`Timed out waiting for AGY output: ${expected}`))
            }, timeoutMs)
            this.outputWaiter = { expected, resolve, reject, timer }
        })
    }

    private rejectOutputWaiter(reason: string): void {
        const waiter = this.outputWaiter
        this.outputWaiter = null
        if (!waiter) return
        clearTimeout(waiter.timer)
        waiter.reject(new Error(reason))
    }

    private feedOutput(chunk: string): void {
        const waiter = this.outputWaiter
        const clean = chunk.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, '')
        this.recentOutput = `${this.recentOutput}${clean}`.slice(-2048)
        if (!waiter || !this.recentOutput.includes(waiter.expected)) return
        clearTimeout(waiter.timer)
        this.outputWaiter = null
        waiter.resolve()
    }

    private armQuotaDetector(): void {
        this.quotaDetectorArmed = true
        this.quotaDetectorRawTail = ''
        this.quotaReportedForCurrentRun = false
    }

    private disarmQuotaDetector(): void {
        this.quotaDetectorArmed = false
        this.quotaDetectorRawTail = ''
    }

    private detectQuotaOutput(chunk: string): void {
        if (!this.quotaDetectorArmed || this.quotaReportedForCurrentRun) return
        this.quotaDetectorRawTail = `${this.quotaDetectorRawTail}${chunk}`.slice(-QUOTA_DETECTOR_RAW_TAIL_SIZE)
        const cleanOutput = stripTerminalControlSequences(this.quotaDetectorRawTail).replace(/\s+/g, ' ')
        const hasQuotaFrame = cleanOutput.includes(QUOTA_ANCHOR)
            && /\bError ID:\s*[0-9a-f]{8}(?:-[0-9a-f]+){4,}\b/i.test(cleanOutput)
            && cleanOutput.includes(QUOTA_SCREEN_CONTEXT)
            && /\?\s+for shortcuts\b/.test(cleanOutput)
        if (!hasQuotaFrame) return

        // The quota screen renders the same '? for shortcuts' footer the driver
        // uses as its only idle marker, so readiness must be invalidated here.
        // Otherwise the next queued prompt is typed into a screen that has no
        // editor and the delivery stalls with no way out.
        this.ptyControls?.invalidateInputReady()
        this.quotaReportedForCurrentRun = true
        const reset = quotaResetDuration(cleanOutput)
        this.session.client.sendSessionEvent({
            type: 'error',
            message: reset ? `Antigravity quota reached · resets in ${reset}` : 'Antigravity quota reached',
        })
    }

    private applyLiveModelNow(model: string | null, generation: number): Promise<void> {
        const target = buildAgyModelPickerTarget(model)
        return this.enqueuePtyInteraction(async () => {
            const controls = this.ptyControls
            if (!controls) throw new Error('AGY PTY is not ready for a live model change')
            if (generation !== this.ptyGeneration) throw new Error('AGY PTY restarted before the live model change')

            this.recentOutput = ''
            try {
                const pickerReady = this.waitForOutput('(current)')
                controls.sendKeys('/model\r')
                await pickerReady

                const currentRow = findAgyCurrentModelRow(stripTerminalControlSequences(this.recentOutput))
                if (currentRow === null) throw new Error('AGY model picker did not identify the current model')

                this.recentOutput = ''
                const applied = this.waitForOutput(`Model set to ${target.label}`)
                controls.sendKeys(buildAgyModelNavigationKeys(target, currentRow))
                controls.sendKeys('\r')
                await applied
            } catch (error) {
                controls.sendKeys('\x1b')
                throw error
            }
        }, () => generation === this.ptyGeneration, 'AGY PTY restarted before the live model change')
    }

    private applyLiveModel(model: string | null): Promise<void> {
        buildAgyModelPickerTarget(model)
        if (this.agentRunInProgress || this.agentRunReserved) {
            return Promise.reject(new Error('Wait for the current AGY turn to finish before changing models'))
        }
        return this.applyLiveModelNow(model, this.ptyGeneration)
    }

    private async completeAgentRun(): Promise<void> {
        this.releaseUnechoedWebDelivery()
        this.activeWebPrompt = null
        this.disarmQuotaDetector()
        this.agentRunInProgress = false
    }

    // A submitted prompt whose transcript echo never matched would otherwise
    // hold the delivery boundary forever, wedging every later message while the
    // PTY keeps answering. Completing the run is proof agy received it, so ack
    // and release there instead of waiting for an echo that will not come.
    private releaseUnechoedWebDelivery(): void {
        const pending = this.pendingWebDelivery
        if (!pending?.submitted) return
        logger.warn('[agy-pty]: releasing a submitted delivery at the agent-run boundary; the transcript never echoed it')
        this.session.client.emitMessagesConsumed(pending.localIds)
        this.finishPendingWebDelivery()
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
                    await this.waitForPendingWebDelivery(signal)
                    if (signal.aborted || this.exitReason) return null
                    const msg = await this.session.queue.waitForMessagesAndGetAsString(signal)
                    if (!msg) return null
                    const localIds = (msg.items ?? [])
                        .map((item) => item.localId)
                        .filter((localId): localId is string => Boolean(localId))
                    if (localIds.length > 0) {
                        this.pendingWebDelivery = {
                            message: msg.message,
                            localIds,
                            submitted: false,
                            observedBeforeSubmit: null,
                        }
                    }
                    return { message: msg.message }
                },
                registerControls: (controls) => {
                    this.questionInteractionEpoch += 1
                    this.ptyGeneration += 1
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
                    this.session.client.emitSessionReady()
                    this.session.client.sendSessionEvent({ type: 'ready' })
                },
                onMessage: (data: string) => {
                    this.feedOutput(data)
                    if (process.env.DEBUG_PTY) {
                        logger.debug(`[agy-pty:onMessage] received ${data.length} bytes`)
                    }
                    this.session.client.emitAgentTerminalOutput(data)
                    this.detectQuotaOutput(data)
                },
                onThinkingChange: (thinking: boolean) => {
                    this.session.onThinkingChange(thinking)
                    // Fix 9 (hostile-review round 2): onReady only means the TUI
                    // prompt is usable, not that a model call happened — a user
                    // who spawns agy and reads the prompt for a minute before
                    // typing anything is completely normal, not a discovery
                    // failure. thinking=true is driven by agy's busy marker
                    // ("Generating") in the raw PTY output (see AGY_BUSY_MARKERS,
                    // agyPty.ts) as well as HAPI's own optimistic post-submit
                    // signal, so it fires for BOTH a web-queued message and text
                    // typed directly into the terminal — the first real evidence
                    // a model call is actually in flight, which is what
                    // PreInvocation/PreToolUse hooks fire alongside.
                    if (thinking) {
                        this.armDiscoveryTimeoutWarning()
                    }
                },
                onMessageSubmitted: () => {
                    this.markWebDeliverySubmitted()
                    this.agentRunReserved = false
                    this.agentRunInProgress = true
                },
                onMessageSkipped: () => {
                    const pending = this.pendingWebDelivery
                    if (pending) this.session.client.emitMessagesConsumed(pending.localIds)
                    this.finishPendingWebDelivery()
                },
                onBeforeAgentRunStart: async () => {
                    // Reserve the boundary synchronously. A model request that
                    // arrives after completion but before submit is rejected instead
                    // of racing raw keys with the reserved prompt.
                    this.agentRunReserved = true
                    // A live picker may already have started while nextMessage()
                    // was blocked. Let it finish before typing the queued prompt.
                    await this.interactionTail
                },
                onBeforeMessageSubmit: (message) => {
                    this.activeWebPrompt = message
                    // The driver's text echo has completed but its CR has not
                    // yet been written, so user-input echo cannot trigger this
                    // output-only detector.
                    this.armQuotaDetector()
                },
                onAgentRunCompleted: () => this.completeAgentRun(),
                onExit: (code: number | null) => {
                    logger.debug(`[agy-pty]: agy PTY exited with code ${code}`)
                    this.questionInteractionEpoch += 1
                    this.rejectOutputWaiter('AGY PTY ended while waiting for model output')
                    this.ptyControls = null
                    this.ptyGeneration += 1
                    this.agentRunInProgress = false
                    this.agentRunReserved = false
                    this.activeWebPrompt = null
                    this.disarmQuotaDetector()
                    // A respawn establishes a new PTY generation. No pending
                    // permission or question belongs to that replacement process,
                    // so invalidate every approval card owned by the exited PTY.
                    // The Ctrl-C abort path remains question-only because that PTY
                    // stays alive and can continue serving ordinary approvals.
                    this.session.agyPermissionHandler?.cancelAll('agy PTY exited while a permission request was pending')
                    if (this.pendingWebDelivery) {
                        this.exitReason = 'exit'
                        this.pendingWebDeliveryResolved?.()
                        this.session.client.sendSessionEvent({
                            type: 'message',
                            message: 'agy PTY exited before delivery could be confirmed'
                        })
                        return
                    }
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
            onEntry: (entry) => {
                if (entry.type === 'USER_INPUT') {
                    if (!this.observeUserInput(entry.content ?? '')) {
                        session.client.sendAgySessionMessage(entry, this.agySessionId ?? undefined)
                    }
                    return
                }
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

        // Bridge brain-UUID discovery (the agy PreToolUse/PreInvocation hooks,
        // via runAgy.ts:onPreToolUse/onAgyPreInvocation -> wrapper.onSessionFound)
        // into the scanner — this is the scanner's ONLY discovery signal (see
        // agySessionScanner.ts: it no longer discovers brains by transcript
        // content-matching). handleSessionFound is the ONLY writer of
        // this.agySessionId (besides the constructor's resume seed) — there
        // is no onMessage-side fallback anymore. Setting it synchronously
        // here (not just forwarding to the scanner) matters for a
        // crash/respawn: launchOnce reads this.agySessionId to pass
        // --conversation to the next spawn, so it must already be current by
        // the time a respawn happens, however soon after this hook fired.
        const handleSessionFound = (uuid: string) => {
            this.agySessionId = uuid
            this.scanner?.onNewSession(uuid)
            this.clearDiscoveryTimeoutWarning()
            this.detachPreInvocationHook()
        }
        session.addSessionFoundCallback(handleSessionFound)
        session.setLiveModelHandler((model) => this.applyLiveModel(model))

        try {
            await this.runRespawnLoop({
                maxAuthRetries: 8,
                authRetryDelayMs: 1500,
                onLaunchStart: (isNewSession) => {
                    // Runs synchronously before every launchOnce, including
                    // the first — restores PreInvocation if a prior round
                    // detached it (see syncPreInvocationHookForLaunch's docstring).
                    this.syncPreInvocationHookForLaunch()
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
            this.clearDiscoveryTimeoutWarning()
            session.setLiveModelHandler(null)
            if (this.outputWaiter) {
                clearTimeout(this.outputWaiter.timer)
                this.outputWaiter.reject(new Error('AGY PTY ended during a live model change'))
                this.outputWaiter = null
            }
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
