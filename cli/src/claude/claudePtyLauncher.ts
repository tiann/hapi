import React from "react"
import { Session } from "./session"
import { RemoteModeDisplay } from "@/ui/ink/RemoteModeDisplay"
import { claudePty } from "./claudePty"
import { bracketPasteIfMultiline } from "@/agent/bracketedPaste"
import { createSessionScanner, type SessionScanner } from "./utils/sessionScanner"
import { getProjectPath } from "./utils/path"
import { isClaudeChatVisibleMessage } from "./utils/chatVisibility"
import { isExternalUserMessage } from "@/api/apiSession"
import type { SessionEffort, SessionModel } from "@/api/types"
import { logger } from "@/ui/logger"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import {
    RemoteLauncherBase,
    type RemoteLauncherDisplayContext,
    type RemoteLauncherExitReason,
    type LaunchOutcome
} from "@/modules/common/remote/RemoteLauncherBase"

// Delay before respawning the PTY after a launch failure, so a persistent
// failure surfaces its error at a steady cadence instead of a tight respawn loop.
const RESPAWN_BACKOFF_MS = 1000
// Give up after this many consecutive launches that never reached a ready
// prompt. Such failures are deterministic (claude not installed, terminal can't
// attach) and will not recover by respawning — bound them so the session ends
// with a clear error instead of retrying forever. A launch that DOES reach
// ready resets the counter, so genuine mid-session crash recovery stays
// unbounded.
const MAX_IMMEDIATE_LAUNCH_FAILURES = 3

// Extract the text of the LAST typed user prompt from a claude transcript
// (JSONL). Tool-result user entries and assistant turns carry no prompt text and
// are skipped, so the result is the most recent thing the human actually typed.
// Returns null when nothing parseable is found (caller falls back).
export function lastUserPromptText(transcript: string): string | null {
    let last: string | null = null
    for (const line of transcript.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        let entry: { type?: string; message?: { content?: unknown } }
        try {
            entry = JSON.parse(trimmed)
        } catch {
            continue
        }
        if (entry.type !== 'user') continue
        const content = entry.message?.content
        let text: string | null = null
        if (typeof content === 'string') {
            text = content
        } else if (Array.isArray(content)) {
            const parts = content
                .filter((part): part is { type?: string; text?: string } =>
                    typeof part === 'object' && part !== null)
                .filter((part) => part.type === 'text' && typeof part.text === 'string')
                .map((part) => part.text as string)
            if (parts.length > 0) text = parts.join('')
        }
        if (text !== null && text.length > 0) last = text
    }
    return last
}

// Whether `text` was actually delivered as the latest user prompt in a claude
// transcript. claude writes the user prompt to its JSONL the moment it ingests it
// (before the API call), so a hit confirms delivery. On --resume the file also
// contains the REPLAYED prior conversation, so a plain whole-file substring match
// would false-positive on stale history (e.g. a short "continue") and suppress
// the re-type self-correction. Anchor on the LAST typed user prompt and require
// EQUALITY: only the just-submitted message can be the last prompt, and equality
// (not substring) keeps a new message that is a substring of the prior turn from
// matching stale content. Falls back to a whole-file check only when no user
// prompt parses (e.g. a fresh transcript with nothing to false-match yet).
export function transcriptConfirmsDelivery(transcript: string, text: string): boolean {
    const lastPrompt = lastUserPromptText(transcript)
    if (lastPrompt !== null) return lastPrompt.trim() === text.trim()
    return transcript.includes(text)
}

class ClaudePtyLauncher extends RemoteLauncherBase {
    // Ctrl-U (line-kill): clears the PTY input line from the cursor to the
    // beginning of the line. Used after an Esc interrupt so the aborted
    // prompt text does not bleed into the next submission.
    // Verified in bash PTY (readline-compatible); claude TUI (ink/React
    // input) is unverified on real hardware — confirm at Validation Gate 1.
    // Isolated as a constant so it can be swapped without a grep if a
    // future claude version requires a different sequence.
    private static readonly PTY_CLEAR_LINE = '\x15'

    private readonly session: Session
    private scanner: Awaited<SessionScanner> | null = null
    // Claude's own session UUID (discovered via the SessionStart hook). Used to
    // --resume the conversation if Claude ever has to be re-spawned (e.g. a crash)
    // so the conversation continues with the current model/effort.
    private claudeSessionId: string | null = null
    // Live PTY controls (raw keystroke injection) for in-place /model and /effort.
    private ptyControls: { sendKeys: (data: string) => void } | null = null
    // The model/effort currently applied to the running Claude TUI, so a config
    // change only drives the slash command for what actually changed.
    private appliedModel: SessionModel = null
    private appliedEffort: SessionEffort = null
    // When set, PTY output is fed here to detect claude's "Switch model?" dialog
    // (across chunks, ANSI-stripped) and accept it with Enter.
    private confirmWatch: { feed: (chunk: string) => void } | null = null
    // Coalesce rapid model+effort changes into a single apply pass.
    private configApplyScheduled = false
    // True once claude's SessionStart hook has fired for the CURRENT spawn (reset
    // each (re)launch). Gates the first message so a --resume that's still
    // replaying its transcript doesn't eat the keystrokes (the input box renders
    // before the replay redraw completes; typing then is lost). See waitForSessionStart.
    private sessionStartSeen = false
    private sessionStartResolvers: Array<() => void> = []

    protected getCurrentSessionId(): string | null {
        return this.session.sessionId
    }

    private sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)) }

    // Apply a mid-session model/effort change to the LIVE claude TUI via its
    // /model and /effort slash commands — no re-spawn, so the conversation and
    // scrollback are preserved. claude's /model pops a "Switch model?" dialog
    // (default = Yes); we accept it with Enter.
    private scheduleConfigApply(): void {
        if (this.configApplyScheduled) return
        this.configApplyScheduled = true
        setTimeout(() => { this.configApplyScheduled = false; void this.applyConfigChange() }, 120)
    }

    private async applyConfigChange(): Promise<void> {
        const controls = this.ptyControls
        if (!controls) return
        const model = this.session.getModel()
        const effort = this.session.getEffort()
        if (model !== this.appliedModel) {
            this.appliedModel = model
            if (model) {
                logger.debug(`[pty]: applying model change via /model ${model}`)
                controls.sendKeys(`/model ${model}\r`)
                await this.confirmModelDialog()
            }
        }
        if (effort !== this.appliedEffort) {
            this.appliedEffort = effort
            if (effort) {
                logger.debug(`[pty]: applying effort change via /effort ${effort}`)
                controls.sendKeys(`/effort ${effort}\r`)
                await this.sleep(300)
            }
        }
    }

    private confirmModelDialog(timeoutMs = 3500): Promise<void> {
        return new Promise<void>((resolve) => {
            let settled = false
            let buf = ''
            // Match the dialog across chunks, with ANSI escapes stripped (the TUI
            // interleaves color codes between words, so a raw regex misses it).
            const marker = /yes,\s*switch|switch model|no,\s*go back/i
            const finish = () => { if (settled) return; settled = true; this.confirmWatch = null; resolve() }
            const timer = setTimeout(finish, timeoutMs)
            this.confirmWatch = {
                feed: (chunk: string) => {
                    buf = (buf + chunk.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')).slice(-2000)
                    if (marker.test(buf)) {
                        clearTimeout(timer)
                        // Default-highlighted option is "Yes, switch" — Enter accepts.
                        setTimeout(() => this.ptyControls?.sendKeys('\r'), 200)
                        finish()
                    }
                }
            }
        })
    }

    // Re-derive Claude's spawn args each (re)launch: --model/--effort/--resume are
    // dynamic (the model/effort can change mid-session, and a re-spawn must resume
    // the existing conversation), so strip any stale copies from the base args and
    // append the current values.
    private buildSpawnArgs(): string[] {
        const DYNAMIC = new Set(['--model', '--effort', '--resume'])
        const base: string[] = []
        const args = this.session.claudeArgs ?? []
        // Preserve a HAPI-resume uuid passed in the initial args (first spawn,
        // before the SessionStart hook has reported Claude's own id).
        let resumeFromArgs: string | null = null
        for (let i = 0; i < args.length; i++) {
            if (DYNAMIC.has(args[i])) {
                const hasValue = i + 1 < args.length && !args[i + 1].startsWith('-')
                if (args[i] === '--resume' && hasValue) resumeFromArgs = args[i + 1]
                if (hasValue) i++
                continue
            }
            base.push(args[i])
        }
        const resumeId = this.claudeSessionId ?? resumeFromArgs
        const model = this.session.getModel()
        const effort = this.session.getEffort()
        return [
            ...base,
            ...(resumeId ? ['--resume', resumeId] : []),
            ...(model ? ['--model', model] : []),
            ...(effort ? ['--effort', effort] : []),
        ]
    }

    // The claude session id passed via `--resume <id>` in the initial args (set by
    // the runner when reopening/resuming an existing conversation). Used to seed the
    // scanner with the already-forwarded transcript so resume doesn't re-emit the
    // prior turns (the new runner has a fresh scanner with no memory of what the
    // previous lifetime already sent).
    private resumeIdFromArgs(): string | null {
        const args = this.session.claudeArgs ?? []
        for (let i = 0; i < args.length; i++) {
            if (args[i] === '--resume' && i + 1 < args.length && !args[i + 1].startsWith('-')) {
                return args[i + 1]
            }
        }
        return null
    }

    // Resolve once claude's SessionStart hook fires for the current spawn (or after
    // `timeoutMs` as a fallback so a missed hook never hangs the message loop).
    private waitForSessionStart(timeoutMs: number): Promise<void> {
        if (this.sessionStartSeen) return Promise.resolve()
        return new Promise<void>((resolve) => {
            const wrapped = () => { clearTimeout(timer); resolve() }
            const timer = setTimeout(() => {
                this.sessionStartResolvers = this.sessionStartResolvers.filter((r) => r !== wrapped)
                logger.debug('[pty]: SessionStart hook gate timed out; proceeding with first message')
                resolve()
            }, timeoutMs)
            this.sessionStartResolvers.push(wrapped)
        })
    }

    private markSessionStartSeen(): void {
        this.sessionStartSeen = true
        const resolvers = this.sessionStartResolvers.splice(0)
        for (const r of resolvers) r()
    }

    // Path of the live claude transcript (used to confirm a submitted message was
    // actually ingested). Resolves against the REAL ~/.claude (not the isolated
    // CLAUDE_CONFIG_DIR), mirroring the scanner.
    private transcriptPath(): string | null {
        if (!this.claudeSessionId) return null
        return join(getProjectPath(this.session.path), `${this.claudeSessionId}.jsonl`)
    }

    private async transcriptHasText(text: string): Promise<boolean> {
        const path = this.transcriptPath()
        if (!path) return false
        try {
            return transcriptConfirmsDelivery(await readFile(path, 'utf-8'), text)
        } catch {
            return false
        }
    }

    // Self-correcting delivery for the FIRST message after a (re)spawn. The driver
    // submits it right after nextMessage returns, but a claude --resume that's still
    // painting its replayed conversation can swallow those keystrokes (the input box
    // renders, then a late redraw wipes the typed text) — the message never reaches
    // claude and no response ever comes. Confirm the prompt landed in the transcript
    // and re-type it if not. Guarded by claudeSessionId so we never blindly re-send
    // when we can't verify.
    private async ensureFirstMessageDelivered(text: string, signal: AbortSignal): Promise<void> {
        if (!this.claudeSessionId) return
        const trimmed = text.trim()
        if (!trimmed) return
        for (let attempt = 0; attempt < 3; attempt++) {
            const deadline = Date.now() + 5000
            while (Date.now() < deadline) {
                if (signal.aborted || !!this.exitReason) return
                if (await this.transcriptHasText(trimmed)) return
                await this.sleep(500)
            }
            if (signal.aborted || !!this.exitReason || !this.ptyControls) return
            logger.debug(`[pty]: first message not in transcript after submit; re-typing (attempt ${attempt + 1})`)
            // Match the driver's submit path: a multiline first message must be
            // bracketed-pasted on repair too, otherwise the re-typed newlines act
            // as Enter and Claude receives split prompts instead of the message.
            this.ptyControls.sendKeys(bracketPasteIfMultiline(trimmed))
            await this.sleep(200)
            this.ptyControls.sendKeys('\r')
        }
    }

    constructor(session: Session) {
        super(process.env.DEBUG ? session.logPath : undefined)
        this.session = session
        // Let the runner lifecycle (onBeforeClose) tear down the PTY gracefully
        // on archive/SIGTERM: aborting the controller triggers runAgentPty's
        // synchronous manager.kill(), so the child dies before process.exit.
        session.setKillHandler(() => { void this.abort() })
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
        logger.debug('[pty]: handleAbortRequest (interrupt)')
        if (this.ptyControls) {
            logger.debug('[pty]: Sending interrupt key (Esc) to PTY')
            this.ptyControls.sendKeys('\x1b')
            // Wait briefly before clearing the line: claude TUI (ink) restores
            // the previous prompt to the input line asynchronously after an Esc
            // interrupt. Sending Ctrl-U immediately could race against that
            // restore and leave stale text behind. ~150 ms is enough for the
            // TUI's event loop to complete the restore in practice.
            await this.sleep(150)
            // Clear any lingering input the claude TUI restored to the prompt
            // after the Esc interrupt, so the next submitted message is not
            // prefixed by the aborted text.
            logger.debug('[pty]: Sending line-clear key (Ctrl-U) to PTY')
            this.ptyControls.sendKeys(ClaudePtyLauncher.PTY_CLEAR_LINE)
            // Drop pending queued messages — they were enqueued AFTER the
            // message that is now being aborted and should not be auto-delivered
            // to the fresh prompt.
            this.session.queue.reset()
            // Signal the web composer to restore the aborted prompt text.
            // The web side reads the last user message from normalizedMessages.
            this.session.client.sendSessionEvent({ type: 'abort-restore' })
        } else {
            logger.debug('[pty]: No PTY controls active, falling back to aborting the controller')
            await this.abort()
        }
    }

    private async handleSwitchRequest(): Promise<void> {
        logger.debug('[pty]: doSwitch')
        await this.requestExit('switch', async () => {
            await this.abort()
        })
    }

    private async handleExitFromUi(): Promise<void> {
        logger.debug('[pty]: Exiting via Ctrl-C')
        await this.requestExit('exit', async () => {
            await this.abort()
        })
    }

    private async handleSwitchFromUi(): Promise<void> {
        logger.debug('[pty]: Switching to local mode via double space')
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
        let gatedFirstMessage = false
        let firstSubmitVerified = false
        try {
            await claudePty({
                sessionId: this.session.sessionId,
                path: this.session.path,
                claudeEnvVars: this.session.claudeEnvVars,
                claudeArgs: this.buildSpawnArgs(),
                hookSettingsPath: this.session.hookSettingsPath,
                signal,
                nextMessage: async () => {
                    const msg = await this.session.queue.waitForMessagesAndGetAsString(signal)
                    if (!msg) return null
                    if (!gatedFirstMessage) {
                        gatedFirstMessage = true
                        await this.waitForSessionStart(15000)
                        if (signal.aborted) return null
                    }
                    this.scanner?.markActive()
                    if (/^\/model\s+\S/i.test(msg.message.trim())) {
                        void this.confirmModelDialog(6000)
                    }
                    return { message: msg.message }
                },
                onMessageSubmitted: (message: string) => {
                    if (firstSubmitVerified) return
                    firstSubmitVerified = true
                    void this.ensureFirstMessageDelivered(message, signal)
                },
                onReady: () => {
                    reachedReady = true
                    logger.debug('[pty]: claude PTY ready')
                    this.session.client.sendSessionEvent({ type: 'ready' })
                },
                onMessage: (data: string) => {
                    if (process.env.DEBUG_PTY) {
                        logger.debug(`[pty:onMessage] received ${data.length} bytes: ${data.slice(0, 80)}`)
                    }
                    if (this.confirmWatch) this.confirmWatch.feed(data)
                    this.session.client.emitAgentTerminalOutput(data)
                },
                onThinkingChange: (thinking: boolean) => {
                    this.session.onThinkingChange(thinking)
                },
                registerControls: (controls) => {
                    this.ptyControls = controls
                    this.session.client.resetAgentTerminal()
                    this.session.client.setAgentTerminalControls(controls)
                },
                onExit: (code: number | null) => {
                    logger.debug(`[pty]: claude PTY exited with code ${code}`)
                    this.ptyControls = null
                    this.session.client.sendSessionEvent({
                        type: 'message',
                        message: `Process exited with code ${code}`
                    })
                },
            })

            this.session.consumeOneTimeFlags()

            if (!this.exitReason && signal.aborted) {
                this.session.client.sendSessionEvent({ type: 'message', message: 'Aborted by user' })
            }

            return { reachedReady }
        } catch (e) {
            return { reachedReady, error: e instanceof Error ? e : new Error(String(e)) }
        }
    }

    protected async runMainLoop(): Promise<void> {
        logger.debug('[claudePtyLauncher] Starting PTY launcher')
        logger.debug(`[claudePtyLauncher] TTY available: ${this.hasTTY}`)

        const session = this.session
        const messageBuffer = this.messageBuffer

        this.setupAbortHandlers(session.client.rpcHandlerManager, {
            onAbort: () => this.handleAbortRequest(),
            onSwitch: () => this.handleSwitchRequest()
        })

        const resumeId = this.resumeIdFromArgs()
        if (resumeId) this.claudeSessionId = resumeId
        this.scanner = await createSessionScanner({
            sessionId: resumeId ?? session.sessionId,
            workingDirectory: session.path,
            onMessage: (message) => {
                if (message.type === 'summary') return
                if (message.isMeta || message.isCompactSummary) return
                if (!isClaudeChatVisibleMessage(message)) return
                if (isExternalUserMessage(message)) return
                session.client.sendClaudeSessionMessage(message)
            }
        })
        const handleSessionFound = (sessionId: string) => {
            this.claudeSessionId = sessionId
            this.markSessionStartSeen()
            this.scanner?.onNewSession(sessionId)
        }
        session.addSessionFoundCallback(handleSessionFound)

        this.appliedModel = session.getModel()
        this.appliedEffort = session.getEffort()

        session.setConfigChangeHandler(() => this.scheduleConfigApply())

        try {
            await this.runRespawnLoop({
                maxImmediateFailures: MAX_IMMEDIATE_LAUNCH_FAILURES,
                respawnBackoffMs: RESPAWN_BACKOFF_MS,
                onLaunchStart: (isNewSession) => {
                    messageBuffer.addMessage('═'.repeat(40), 'status')
                    if (isNewSession) {
                        messageBuffer.addMessage('Starting new Claude PTY session...', 'status')
                    } else {
                        messageBuffer.addMessage('Continuing Claude PTY session...', 'status')
                    }
                },
                launchOnce: (sig) => this.launchOnce(sig),
                onLaunchFailure: (err) => {
                    session.client.sendSessionEvent({ type: 'message', message: err.message })
                }
            })
        } finally {
            session.setConfigChangeHandler(null)
            session.client.setAgentTerminalControls(null)
            session.removeSessionFoundCallback(handleSessionFound)
            if (this.scanner) {
                await this.scanner.cleanup()
                this.scanner = null
            }
            logger.debug('[pty]: main loop ended')
        }
    }

    protected async cleanup(): Promise<void> {
        this.clearAbortHandlers(this.session.client.rpcHandlerManager)
        logger.debug('[pty]: cleanup done')
    }
}

export async function claudePtyLauncher(session: Session): Promise<'switch' | 'exit'> {
    const launcher = new ClaudePtyLauncher(session)
    return launcher.launch()
}
