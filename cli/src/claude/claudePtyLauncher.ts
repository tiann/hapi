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
import type { ClaudePermissionMode } from "@hapi/protocol/types"
import {
    RemoteLauncherBase,
    type RemoteLauncherDisplayContext,
    type RemoteLauncherExitReason,
    type LaunchOutcome
} from "@/modules/common/remote/RemoteLauncherBase"

// HAPI's ClaudePermissionMode has no `manual` literal (it calls that mode
// `default`), but claude's own `--permission-mode` flag has no `default`
// literal — verified via `claude --help`: the accepted values are exactly
// acceptEdits, auto, bypassPermissions, manual, dontAsk, plan. Passing HAPI's
// `default` straight through makes claude reject the flag and the spawn fails.
// `bypassPermissions` is handled separately (omitted from spawn args — see
// buildSpawnArgs) so it has no entry here.
const CLAUDE_SPAWN_PERMISSION_MODE: Readonly<Record<Exclude<ClaudePermissionMode, 'bypassPermissions'>, string>> = {
    default: 'manual',
    acceptEdits: 'acceptEdits',
    plan: 'plan',
    auto: 'auto',
}

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
    // The prompt currently being processed, captured on submit and cleared when
    // the turn goes idle. Drives abort-restore: only a prompt that is actually
    // in flight when the user aborts is restored to the web composer — aborting
    // during idle/startup/no-submission restores nothing.
    private promptToRestoreOnAbort: string | null = null
    // The model/effort currently applied to the running Claude TUI, so a config
    // change only drives the slash command for what actually changed.
    private appliedModel: SessionModel = null
    private appliedEffort: SessionEffort = null
    // The permissionMode the CURRENTLY RUNNING claude process was (or is being)
    // spawned with. Mirrors appliedModel/appliedEffort but is reconciled at the
    // top of every launchOnce (not just when a change is applied) — see
    // launchOnce — because unlike model/effort, a permissionMode change takes
    // effect via a full respawn (see respawnForPermissionMode), and a change
    // that arrives while a respawn is already in flight is naturally picked up
    // by the NEXT launchOnce's buildSpawnArgs() regardless of what triggered it.
    private appliedPermissionMode: ClaudePermissionMode | null = null
    // True while the CURRENT launchOnce's PTY is being killed by a deliberate
    // permission-mode respawn (see respawnForPermissionMode), as opposed to a
    // real user-initiated abort or a crash. Reset at the top of every
    // launchOnce and set (if it happens at all) only while that same
    // launchOnce's claudePty() call is in flight, so by the time launchOnce
    // checks `signal.aborted` after claudePty() returns, this flag correctly
    // reflects whether THIS invocation's abort was the deliberate respawn.
    // Gates the "Aborted by user" session event so a permission-mode change
    // does not show a false abort message on every respawn (the respawn is
    // meant to be invisible — see Fix 1 in the plan).
    private respawningForConfig = false
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
        // permission-mode respawn only needs ptyAbortController (a class field
        // independent of ptyControls) — checked FIRST, ahead of the `!controls`
        // early return below. A running claude fixes its mode at spawn, so
        // between a previous respawn's kill and its replacement process's
        // registerControls callback, ptyControls is null (can outlast the
        // 120ms debounce on a cold cache / slow claude startup). Gating the
        // whole function behind `!controls` would silently drop a permission
        // mode change that arrives in that window: session.getPermissionMode()
        // would already report the new target, but the running process would
        // keep the old one until some LATER distinct change happened to
        // trigger a respawn — a lost update the web would not be able to tell
        // apart from a successful switch (it already shows the new mode
        // optimistically).
        const permissionMode = this.session.getPermissionMode()
        if (permissionMode !== undefined && permissionMode !== this.appliedPermissionMode) {
            this.appliedPermissionMode = permissionMode
            this.respawnForPermissionMode(permissionMode)
        }

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

    // Unlike model/effort (which have /model and /effort slash commands claude
    // applies in place), a running claude process fixes its permission mode at
    // spawn — there is no live command or reliable keybinding to change it
    // in-place. Converge on a new target by killing the current PTY child
    // WITHOUT setting exitReason: RemoteLauncherBase.runRespawnLoop's `while
    // (!this.exitReason)` loop treats that exactly like a mid-session crash and
    // immediately re-launches via launchOnce, whose buildSpawnArgs() reads
    // session.getPermissionMode() fresh and resumes the SAME conversation via
    // `--resume <claudeSessionId>` — the same recovery path the base class
    // already uses for an unexpected crash, just triggered deliberately here.
    // A turn that was mid-flight is interrupted by the respawn; that is this
    // design's accepted cost (the caller changed the permission mode on
    // purpose), not a session-ending failure.
    private respawnForPermissionMode(target: ClaudePermissionMode): void {
        if (!this.ptyAbortController || this.ptyAbortController.signal.aborted) return
        logger.debug(`[pty]: respawning PTY for permissionMode change -> ${target}`)
        // Suppress the generic "Aborted by user" session event this deliberate
        // abort would otherwise trigger in launchOnce (see Fix 1) — this
        // respawn is meant to be invisible to the user, mirroring the seamless
        // in-place feel of a /model or /effort change.
        this.respawningForConfig = true
        // A message that is genuinely in flight (already dequeued and
        // submitted to the OLD claude process — tracked via
        // promptToRestoreOnAbort) may have already driven side-effecting tools
        // (file edits, shell commands) before the respawn interrupts it.
        // Re-queuing it (unshift) for automatic re-submission after `--resume`
        // would silently repeat those side effects, even though `--resume`
        // itself does not regenerate or continue the interrupted turn (it
        // locally appends a synthetic no-op close-out pair to the transcript).
        // Instead, mirror handleAbortRequest's user-abort path exactly: emit
        // `abort-restore` so the web composer restores the prompt text and
        // the user decides whether to re-submit it, with the actually-applied
        // side effects visible in the transcript first.
        const inFlightPrompt = this.promptToRestoreOnAbort
        if (inFlightPrompt) {
            this.promptToRestoreOnAbort = null
            this.session.client.sendSessionEvent({ type: 'abort-restore', text: inFlightPrompt })
        }
        this.ptyAbortController.abort()
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

    // Re-derive Claude's spawn args each (re)launch: --model/--effort/--resume/
    // --permission-mode are dynamic (they can change mid-session, and a re-spawn
    // must resume the existing conversation with the current values), so strip
    // any stale copies from the base args and append the current values.
    private buildSpawnArgs(): string[] {
        const DYNAMIC = new Set(['--model', '--effort', '--resume', '--permission-mode'])
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
        const permissionMode = this.session.getPermissionMode()
        return [
            ...base,
            ...(resumeId ? ['--resume', resumeId] : []),
            ...(model ? ['--model', model] : []),
            ...(effort ? ['--effort', effort] : []),
            // bypassPermissions is deliberately excluded: passing it as
            // --permission-mode makes claude bypass the PreToolUse hook the
            // same way --dangerously-skip-permissions does (see claude.ts),
            // which would break question-tool routing to the web. It stays
            // hook-emulated only (resolveClaudeModePolicy auto-allows it).
            // Every other mode is mapped through CLAUDE_SPAWN_PERMISSION_MODE:
            // HAPI's `default` has no `--permission-mode` equivalent literal in
            // claude (claude calls that mode `manual`) — passing `default`
            // straight through makes claude reject the flag and fail to spawn.
            ...(permissionMode && permissionMode !== 'bypassPermissions'
                ? ['--permission-mode', CLAUDE_SPAWN_PERMISSION_MODE[permissionMode]]
                : []),
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
            // Capture synchronously up front: the Esc interrupt below can drive
            // the TUI back to idle (clearing promptToRestoreOnAbort via
            // onThinkingChange) before this handler finishes its 150 ms wait.
            const promptToRestore = this.promptToRestoreOnAbort
            this.promptToRestoreOnAbort = null
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
            // to the fresh prompt. Ack them as consumed first: reset() alone
            // clears the queue without firing onBatchConsumed, so the hub would
            // keep them invoked_at=null (stuck "queued" in the web, and re-sent
            // to the fresh prompt by seq-backfill on reconnect) — defeating abort.
            const droppedLocalIds = this.session.queue.pendingLocalIds()
            this.session.queue.reset()
            if (droppedLocalIds.length > 0) {
                this.session.client.emitMessagesConsumed(droppedLocalIds)
            }
            // Signal the web composer to restore the exact prompt that was in
            // flight. Skip the signal entirely when nothing was being processed
            // so an old prompt is never replayed into an empty composer.
            if (promptToRestore) {
                this.session.client.sendSessionEvent({ type: 'abort-restore', text: promptToRestore })
            }
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
        // This launch's own controls, captured from registerControls below.
        // onExit uses this (not the shared this.ptyControls) to decide whether
        // it is safe to null out this.ptyControls — see the onExit comment for
        // why a straight unconditional null is unsafe.
        let myControls: { sendKeys: (data: string) => void } | null = null
        // This spawn's args (buildSpawnArgs, called below) already read
        // session.getPermissionMode() fresh, so whatever that value is right now
        // is what THIS process is being launched with — fold it into applied
        // bookkeeping here rather than only where the change was first
        // requested. This absorbs a change that arrived while a previous
        // respawn was already in flight (ptyControls null, so applyConfigChange
        // could not act on it) into the spawn that is happening anyway, and
        // keeps a later toggle back to an old target from being skipped by
        // applyConfigChange's dedup.
        this.appliedPermissionMode = this.session.getPermissionMode() ?? null
        // Reset for this spawn's lifetime. respawnForPermissionMode sets this
        // back to true (synchronously, before aborting) only if IT is what
        // ends this specific claudePty() call below — see the signal.aborted
        // check after the try block.
        this.respawningForConfig = false
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
                    // Track the in-flight prompt for abort-restore on every submit.
                    this.promptToRestoreOnAbort = message
                    if (firstSubmitVerified) return
                    firstSubmitVerified = true
                    void this.ensureFirstMessageDelivered(message, signal)
                },
                onReady: () => {
                    reachedReady = true
                    logger.debug('[pty]: claude PTY ready')
                    // Hub-level readiness: the spawn flow waits for this so a
                    // failed/auth-blocked/early-exit PTY launch surfaces as a
                    // spawn error instead of an empty terminal. session-alive
                    // (emitted at construction) is too early to mean "usable".
                    this.session.client.emitSessionReady()
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
                    // Turn finished → the prompt is no longer in flight, so a
                    // later abort during idle must not restore it.
                    if (!thinking) this.promptToRestoreOnAbort = null
                    this.session.onThinkingChange(thinking)
                },
                registerControls: (controls) => {
                    myControls = controls
                    this.ptyControls = controls
                    this.session.client.resetAgentTerminal()
                    this.session.client.setAgentTerminalControls(controls)
                },
                onExit: (code: number | null) => {
                    logger.debug(`[pty]: claude PTY exited with code ${code}`)
                    // Only clear this.ptyControls if it still points at what THIS
                    // launch installed. onExit fires when the killed child is
                    // actually reaped by the OS — asynchronously, and NOT
                    // ordered against claudePty()'s own promise resolving. On a
                    // deliberate respawn (respawnForPermissionMode aborts
                    // without setting exitReason), claudePty() for this launch
                    // can resolve, runRespawnLoop can advance to the NEXT
                    // launchOnce, and that next launch's registerControls can
                    // install controls#2 on this.ptyControls — all BEFORE this
                    // stale onExit macrotask runs. An unconditional
                    // `this.ptyControls = null` here would then clobber the
                    // live process's controls out from under it (breaking
                    // in-place /model, /effort, and Esc-abort for the entire
                    // remaining lifetime of that process). Comparing against
                    // myControls (this launch's own closure-captured reference)
                    // makes the null-out a no-op once ownership has moved on.
                    if (this.ptyControls === myControls) this.ptyControls = null
                    // Sibling of the "Aborted by user" gate below: a deliberate
                    // permission-mode respawn kills this same process, and
                    // without this gate every respawn would also show a
                    // spurious "Process exited with code ..." message in the
                    // web chat (the same false-alarm class Fix 1 addresses),
                    // undermining the intended seamless respawn UX.
                    //
                    // Gated on THIS launch's `signal` (closure-captured),
                    // NOT the shared `respawningForConfig` flag: for the same
                    // async-ordering reason as above, by the time this stale
                    // onExit fires, the NEXT launchOnce may have already reset
                    // respawningForConfig to false at its top, making the flag
                    // read as "not a respawn" even though it was. `signal` has
                    // no such reset — once aborted it stays aborted for the
                    // rest of this launch's lifetime, so it correctly reflects
                    // whether THIS launch's death was deliberate (respawn OR
                    // user abort OR session exit — all of which already show
                    // their own message, e.g. "Aborted by user" below) versus a
                    // genuine unexpected crash (signal never aborted).
                    if (!signal.aborted) {
                        this.session.client.sendSessionEvent({
                            type: 'message',
                            message: `Process exited with code ${code}`
                        })
                    }
                },
            })

            this.session.consumeOneTimeFlags()

            if (!this.exitReason && signal.aborted && !this.respawningForConfig) {
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
        this.appliedPermissionMode = session.getPermissionMode() ?? null

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
