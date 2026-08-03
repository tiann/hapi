import { AgentPtyManager } from "@/agent/AgentPtyManager"
import { parseSpecialCommand } from "@/parsers/specialCommands"
import { bracketPasteIfMultiline } from "@/agent/bracketedPaste"
import { logger } from "@/lib"

/**
 * Shared driver for running an interactive agent CLI (claude, agy, ...) inside a
 * PTY. All flavor-specific behavior is supplied via options:
 *  - `command` / `args` / `cwd` / `envVars` / `extraEnv` — how to spawn
 *  - `promptMarkers` — strings that indicate the agent's input prompt has
 *    rendered. When provided, input-ready is gated on seeing one of them.
 *    When omitted, falls back to an output-idle heuristic.
 *
 * The driver handles the parts every PTY agent shares: spawn lifecycle,
 * waiting until the agent is ready before sending the first message, echo-
 * confirmed submit with retry (so the first keystrokes aren't dropped while the
 * agent wires up stdin), and the message loop.
 */
export type RunAgentPtyOpts = {
    command: string
    args: string[]
    cwd: string
    /** Flavor env vars merged into process.env before spawn. */
    envVars?: Record<string, string>
    /** Additional env vars (e.g. DISABLE_AUTOUPDATER) applied after envVars. */
    extraEnv?: Record<string, string>
    /**
     * Env var names to REMOVE from the spawned process's environment. agy uses
     * this to strip SSH_* vars: when agy detects an SSH session (via SSH_AUTH_SOCK
     * etc.) it switches to a degraded keyring code path with aggressive 1s/5s
     * timeouts that fall back to (empty) file storage and fail to authenticate.
     * Removing the SSH markers makes agy take the normal keyring path, which reads
     * the (unlocked) login keyring instantly and signs in.
     */
    unsetEnv?: string[]
    /**
     * Output markers that signal the input prompt has rendered. A string is
     * matched as a substring; a RegExp is matched with `.test()`. Use a RegExp
     * when the marker must tolerate a moving part (e.g. agy's banner carries the
     * CLI version — `/Antigravity CLI \d/` — so a version bump doesn't silently
     * break readiness detection).
     */
    promptMarkers?: (string | RegExp)[]
    /**
     * Fail startup when no prompt marker appears instead of proceeding after the
     * readiness timeout. After startup, wait indefinitely for each fresh prompt
     * before dequeuing so a long-running turn cannot strand a queued message.
     */
    requirePromptMarker?: boolean
    /** Startup prompt deadline in milliseconds. Default 20000. */
    inputReadyTimeoutMs?: number
    /**
     * Before declaring startup ready, force a PTY resize and require the prompt
     * marker to be redrawn. This distinguishes the current input screen from a
     * stale marker without writing anything into the editor.
     */
    verifyPromptAfterResize?: boolean
    /**
     * Output substrings that indicate a trust/safety prompt the agent shows on
     * first run in a folder (e.g. claude's "Is this a project you trust?").
     * When detected, the driver auto-approves it (Enter selects the default
     * "Yes" option) so the trust screen doesn't get mistaken for the input
     * prompt and the first user message isn't consumed by it.
     * Strings match as substrings; RegExps match with `.test()`.
     */
    trustMarkers?: (string | RegExp)[]
    /**
     * Output substrings that indicate the agent failed to authenticate and is
     * sitting at a login/menu screen instead of the input prompt (e.g. agy's
     * "Select login method" / "not signed in"). agy's keyring auth intermittently
     * times out (a hardcoded, non-configurable 5s ceiling), so when one of these
     * is seen before the input prompt, the driver fires onAuthFailure and kills
     * the PTY so the launcher can re-spawn — each fresh spawn has a fair chance of
     * authenticating, so a few retries converge.
     * Strings match as substrings; RegExps match with `.test()`.
     */
    authFailureMarkers?: (string | RegExp)[]
    /**
     * How long (ms) to let the agent's auth handshake settle before deciding a
     * lingering login-menu screen is a real auth failure. Only used when
     * authFailureMarkers is set. Default 12000.
     */
    authSettleMs?: number
    /** Idle window (ms) used to decide output has settled. */
    idleReadyMs?: number
    /**
     * Output substrings shown while the agent is actively working (e.g. claude's
     * "esc to interrupt" footer / spinner). When seen, `onThinkingChange(true)`.
     * Strings match as substrings; RegExps match with `.test()`.
     */
    busyMarkers?: (string | RegExp)[]
    /**
     * Output substrings shown when the agent is back at an idle input prompt
     * (e.g. claude's "for shortcuts" hint). When seen, `onThinkingChange(false)`.
     * Strings match as substrings; RegExps match with `.test()`.
     */
    idleMarkers?: (string | RegExp)[]
    debugPrefix: string
    signal?: AbortSignal
    nextMessage: () => Promise<{ message: string } | null>
    onReady: () => void
    onMessage: (data: string) => void
    /**
     * Fired when the agent's working/idle state changes, derived from
     * busy/idle markers in the PTY output. Drives the chat "thinking" indicator
     * (PTY agents have no streaming protocol to read this from). Tracks the live
     * spinner, so it stays accurate even through a long silent inference.
     */
    onThinkingChange?: (thinking: boolean) => void
    onExit?: (code: number | null) => void
    /** Fired when an authFailureMarker is seen before the agent becomes ready. */
    onAuthFailure?: () => void
    /**
     * Fired after a message has been written to the PTY (text + CR) by the
     * driver's submit path. Callers that want to verify/repair delivery of a
     * message must hook here rather than at nextMessage time: nextMessage
     * returns BEFORE waitForInputReady + submitMessage run, so a verifier
     * started there can race the driver's own submit (and on a slow resume,
     * fire its repair keystrokes before the message was ever sent — duplicating
     * it). This hook guarantees the submit already happened.
     */
    onMessageSubmitted?: (message: string) => void | Promise<void>
    /** Fired when a dequeued slash command is intentionally ignored by the PTY driver. */
    onMessageSkipped?: (message: string) => void | Promise<void>
    /** Called at the serialized boundary immediately before a queued message starts a new agent run. */
    onBeforeAgentRunStart?: () => void | Promise<void>
    /**
     * Called after the queued text has echoed from the PTY, immediately before
     * the driver writes its separate CR submit key. This is the first safe
     * boundary for output observers that must ignore user-input echo.
     */
    onBeforeMessageSubmit?: (message: string) => void | Promise<void>
    /**
     * Fired once after a submitted agent run has shown a busy marker and then
     * returned to an explicit idle prompt marker. The next queued message is
     * not submitted until this promise settles.
     */
    onAgentRunCompleted?: () => void | Promise<void>
    /**
     * Called once the PTY is spawned with controls for the live terminal. The
     * agent-terminal viewer uses `resize` to repaint the TUI on (re)subscribe so
     * the current screen is shown instead of a stale/black buffer replay. Controls
     * become no-ops after the process exits.
     */
    registerControls?: (controls: {
        resize: (cols: number, rows: number) => void
        sendKeys: (data: string) => void
        /** Mark the current prompt consumed by an out-of-band TUI interaction. */
        invalidateInputReady: () => void
    }) => void
}

export async function runAgentPty(opts: RunAgentPtyOpts): Promise<void> {
    const { debugPrefix } = opts
    logger.debug(`${debugPrefix} Starting PTY session`)

    // Flavor env vars are scoped to the spawned child so agent-specific
    // configuration cannot leak into the parent process.
    const spawnEnv = {
        ...process.env,
        // PTY agents with a full TUI need TERM set. agy (bubbletea) in particular
        // silently falls back to its "not signed in" login menu when TERM is
        // absent — which the runner's Bun.spawn env lacks — dropping all input.
        // Default to a sane terminal so the interactive TUI initializes correctly.
        TERM: process.env.TERM || 'xterm-256color',
        ...(opts.envVars ?? {}),
        ...(opts.extraEnv ?? {}),
    } as Record<string, string>

    for (const key of opts.unsetEnv ?? []) {
        delete spawnEnv[key]
    }

    const manager = new AgentPtyManager()
    const signal = opts.signal
    const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
    let currentCols = 80
    let currentRows = 24

    // Match an output chunk against a marker: substring for strings, `.test()`
    // for RegExps. RegExp markers must be non-global (a `g` flag makes `.test()`
    // stateful via lastIndex and would match every other call).
    const markerMatches = (data: string, marker: string | RegExp): boolean =>
        typeof marker === 'string' ? data.includes(marker) : marker.test(data)
    const anyMarker = (data: string, list: (string | RegExp)[]): boolean =>
        list.some((m) => markerMatches(data, m))

    const markers = opts.promptMarkers ?? []
    const hasMarkers = markers.length > 0
    const requirePromptMarker = opts.requirePromptMarker ?? false
    const trustMarkers = opts.trustMarkers ?? []
    const authFailureMarkers = opts.authFailureMarkers ?? []
    const idleReadyMs = opts.idleReadyMs ?? (hasMarkers ? 500 : 1000)

    let lastOutputAt = 0
    let sawOutput = false
    // For marker-based agents (claude): true once the input prompt rendered.
    let promptSeen = false
    // Re-armable readiness: true only while the agent is actually sitting at an
    // input prompt. Set by a prompt/idle marker (or the idle watchdog) and
    // cleared on a busy marker and on every submit, so a queued message waits for
    // a fresh prompt rather than any mid-turn output gap.
    let inputReady = false
    // Set whenever the login-menu screen is seen before the input prompt.
    let sawAuthFailureScreen = false
    // Whether the first-run trust/safety prompt has been auto-approved.
    let trustHandled = false
    // PTY output may split a footer anywhere, including inside the marker text.
    // Keep a small rolling tail and reset it at each busy/submit boundary so an
    // old idle footer cannot make a later turn look ready.
    const PROMPT_BUFFER_SIZE = 4096
    let promptBuffer = ''

    // Working/idle state derived from busy/idle markers, reported only on change.
    const busyMarkers = opts.busyMarkers ?? []
    const idleMarkers = opts.idleMarkers ?? []
    const hasBusyMarkers = busyMarkers.length > 0
    let thinking = false
    // Output-silence watchdog against a stuck "thinking" indicator. The post-submit
    // setThinking(true) is optimistic, and the idle MARKER that should clear it can
    // be missed (it arrives mid-chunk with a busy marker, or fragmented across
    // reads), so the spinner can stick long after the turn ends — or forever if the
    // turn never started (a --resume replay swallowed the first message). A working
    // claude repaints its spinner footer every few hundred ms, so once output has
    // been SILENT for IDLE_SILENCE_MS while we still think it's busy, the turn is
    // really over → force idle. Scoped to agents with a busy marker (claude): agy
    // can sit silent mid-inference (no animated spinner), so it keeps marker-only
    // clearing and no silence watchdog.
    const IDLE_SILENCE_MS = 3000
    let idleWatchdog: ReturnType<typeof setTimeout> | null = null
    let agentRunActive = false
    let agentRunSawBusyMarker = false
    let agentRunBoundaryTask: Promise<void> = Promise.resolve()
    const completeAgentRun = (): void => {
        if (!agentRunActive || !agentRunSawBusyMarker) return
        agentRunActive = false
        agentRunSawBusyMarker = false
        agentRunBoundaryTask = Promise.resolve(opts.onAgentRunCompleted?.()).catch((error) => {
            logger.debug(`${debugPrefix} onAgentRunCompleted failed`, error)
        })
    }
    const disarmIdleWatchdog = (): void => {
        if (idleWatchdog) { clearTimeout(idleWatchdog); idleWatchdog = null }
    }
    // (Re)start the silence timer. Called when thinking begins and on every output
    // chunk while thinking, so the window only elapses once claude has gone quiet.
    const armIdleWatchdog = (): void => {
        if (!hasBusyMarkers || !thinking) return
        disarmIdleWatchdog()
        idleWatchdog = setTimeout(() => {
            idleWatchdog = null
            if (thinking) {
                logger.debug(`${debugPrefix} idle watchdog: ${IDLE_SILENCE_MS}ms of silence; forcing idle`)
                thinking = false
                // The turn really ended even though no idle marker arrived, so the
                // prompt is usable again — let the next queued message proceed.
                inputReady = true
                opts.onThinkingChange?.(false)
                completeAgentRun()
            }
        }, IDLE_SILENCE_MS)
        idleWatchdog.unref?.()
    }
    const setThinking = (next: boolean): void => {
        if (next === thinking) {
            if (next) armIdleWatchdog() // refresh the silence window on repeated busy signals
            return
        }
        thinking = next
        if (next) armIdleWatchdog()
        else disarmIdleWatchdog()
        opts.onThinkingChange?.(next)
    }

    // Wait until the agent's TUI is ready to receive input. Marker-based agents
    // require both the prompt marker AND settled output; markerless agents use
    // idle alone. Legacy callers retain the bounded fallback; strict callers
    // fail startup closed and wait without a deadline between normal turns.
    const waitForInputReady = async (timeoutMs?: number): Promise<void> => {
        const start = Date.now()
        while (timeoutMs === undefined || Date.now() - start < timeoutMs) {
            if (signal?.aborted || !manager.isRunning) return
            const idle = Date.now() - lastOutputAt
            if (hasMarkers) {
                // Require the prompt to be live (inputReady), not just a silence
                // gap — a long response can go quiet mid-turn. The idle watchdog
                // re-arms inputReady if an idle marker is missed, and the outer
                // timeout is the final fallback.
                if (inputReady && idle >= idleReadyMs) return
            } else if (sawOutput && idle >= idleReadyMs) {
                return
            }
            await sleep(80)
        }
        if (requirePromptMarker) {
            throw new Error(`${opts.command} PTY did not reach an interactive prompt before timeout`)
        }
    }

    const verifyPromptAfterResize = async (): Promise<void> => {
        inputReady = false
        promptBuffer = ''
        const verificationCols = currentCols > 1 ? currentCols - 1 : currentCols + 1
        try {
            manager.resize(verificationCols, currentRows)
            await waitForInputReady(idleReadyMs + 1500)
        } finally {
            // External terminal resizes may arrive while verification is in
            // flight. Restore the latest tracked size, not a hard-coded default
            // or the now-stale snapshot.
            if (manager.isRunning) manager.resize(currentCols, currentRows)
        }
    }

    // Type the text, confirm the agent ingested it (its TUI echoes keystrokes →
    // output), then submit with CR. If no echo comes back, stdin isn't wired up
    // yet, so retry — this is what was dropping the first message. CR is sent
    // separately so the text isn't submitted before it's buffered.
    const submitMessage = async (message: string): Promise<void> => {
        // Multiline web messages (batched queue flush, attachment prompts,
        // multiline composer input) must be bracketed-pasted so their embedded
        // newlines stay literal instead of each submitting a partial line. The
        // trailing CR sent separately below is what submits the whole block.
        const payload = bracketPasteIfMultiline(message)
        let echoed = false
        for (let attempt = 0; attempt < 3 && !echoed; attempt++) {
            const before = lastOutputAt
            manager.write(payload)
            const waitStart = Date.now()
            while (Date.now() - waitStart < 700) {
                if (signal?.aborted || !manager.isRunning) return
                if (lastOutputAt > before) { echoed = true; break }
                await sleep(40)
            }
            if (!echoed && process.env.DEBUG_PTY) {
                logger.debug(`${debugPrefix} no echo after write (attempt ${attempt + 1}); retrying`)
            }
        }
        await sleep(150)
        await opts.onBeforeMessageSubmit?.(message)
        manager.write('\r')
        await sleep(50)
    }

    const abortHandler = () => {
        logger.debug(`${debugPrefix} Abort signal received`)
        manager.kill()
    }
    signal?.addEventListener('abort', abortHandler, { once: true })

    const EXITED = Symbol('pty-exited')
    let resolveExited!: (value: typeof EXITED) => void
    const exited = new Promise<typeof EXITED>((resolve) => {
        resolveExited = resolve
    })

    try {
        // Captured so a spawn failure can be re-thrown (not swallowed): the PTY
        // manager reports failure via onError + isRunning=false rather than a
        // throw from spawn().
        let spawnError: Error | null = null
        manager.spawn({
            command: opts.command,
            args: opts.args,
            cwd: opts.cwd,
            env: spawnEnv,
            cols: 80,
            rows: 24,
            onData: (data) => {
                let reachedIdleMarker = false
                sawOutput = true
                lastOutputAt = Date.now()
                promptBuffer = (promptBuffer + data).slice(-PROMPT_BUFFER_SIZE)
                // Auto-approve the first-run trust/safety prompt (Enter = default
                // "Yes"). Do this BEFORE prompt detection so the trust screen
                // isn't mistaken for the input prompt — otherwise the first user
                // message gets consumed as the trust answer.
                if (!trustHandled && trustMarkers.length > 0 && anyMarker(data, trustMarkers)) {
                    trustHandled = true
                    logger.debug(`${debugPrefix} trust prompt detected; auto-approving with Enter`)
                    manager.write('\r')
                } else if (hasMarkers && !promptSeen && anyMarker(promptBuffer, markers)) {
                    promptSeen = true
                    inputReady = true
                }
                // Note the login-menu screen if we see it before the prompt. We do
                // NOT act immediately: agy shows this transiently on EVERY startup
                // while its keyring auth handshake is still in flight, and only
                // stays here when auth actually fails. The settle-wait below decides
                // (after giving auth time) whether it's a real failure → re-spawn.
                if (!promptSeen && authFailureMarkers.length > 0
                    && anyMarker(data, authFailureMarkers)) {
                    sawAuthFailureScreen = true
                }
                // Track the working/idle state from the live footer. The busy
                // marker (spinner/"esc to interrupt") wins when both appear in a
                // chunk; chunks with neither leave the state unchanged.
                if (busyMarkers.length > 0 && anyMarker(data, busyMarkers)) {
                    if (agentRunActive) agentRunSawBusyMarker = true
                    setThinking(true)
                    inputReady = false
                    promptBuffer = ''
                } else if (idleMarkers.length > 0 && anyMarker(promptBuffer, idleMarkers)) {
                    setThinking(false)
                    inputReady = true
                    reachedIdleMarker = true
                    promptBuffer = ''
                } else if (thinking) {
                    // Still producing output (e.g. streaming response text with no
                    // footer marker in this chunk) — keep the silence watchdog at bay.
                    armIdleWatchdog()
                }
                if (process.env.DEBUG_PTY) logger.debug(`${debugPrefix} onData: ${data.length} bytes`)
                opts.onMessage(data)
                // Consumers must receive the final idle-footer chunk while the
                // run is still armed; their completion callback can then clear
                // run-scoped state after observing the same raw output.
                if (reachedIdleMarker) completeAgentRun()
            },
            onExit: (code) => {
                logger.debug(`${debugPrefix} Process exited with code ${code}`)
                setThinking(false)
                resolveExited(EXITED)
                opts.onExit?.(code)
            },
            onError: (error) => {
                spawnError = error
                logger.debug(`${debugPrefix} PTY error: ${error.message}`, error)
            },
        })

        if (!manager.isRunning) {
            // Surface the failure instead of returning as if it succeeded;
            // otherwise the launcher can mistake a never-started PTY for a clean exit.
            throw spawnError ?? new Error(`Failed to spawn ${opts.command} PTY`)
        }

        opts.registerControls?.({
            resize: (cols: number, rows: number) => {
                if (!manager.isRunning) return
                if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) return
                currentCols = cols
                currentRows = rows
                manager.resize(cols, rows)
            },
            // Inject raw keystrokes into the live TUI — used to drive in-place
            // settings changes (e.g. claude's `/model`/`/effort` slash commands)
            // without re-spawning the process.
            sendKeys: (data: string) => {
                if (!manager.isRunning || !data) return
                manager.write(data)
            },
            invalidateInputReady: () => {
                inputReady = false
                promptBuffer = ''
            },
        })

        // For auth-gated agents (agy): give the keyring auth handshake time to
        // settle. agy shows its login menu transiently on every startup while auth
        // is in flight; only a FAILED auth leaves it there. If the input prompt
        // still hasn't rendered after authSettleMs and we're stuck on the login
        // menu, request a re-spawn instead of proceeding on a session that never
        // signed in. (A killed-too-early agy never finishes auth — that was the
        // bug this guards against.) Runs before waitForInputReady so an auth
        // failure re-spawns instead of being misread as "exited before ready".
        if (authFailureMarkers.length > 0) {
            const authDeadline = Date.now() + (opts.authSettleMs ?? 12000)
            while (Date.now() < authDeadline) {
                if (!manager.isRunning || signal?.aborted || promptSeen) break
                await sleep(200)
            }
            if (manager.isRunning && !signal?.aborted && !promptSeen && sawAuthFailureScreen) {
                logger.debug(`${debugPrefix} auth did not settle (still at login menu); requesting re-spawn`)
                opts.onAuthFailure?.()
                return
            }
        }

        // Wait until the prompt is actually usable BEFORE any message arrives, so
        // the first user message is processed immediately instead of being
        // consumed as the spawn trigger.
        await waitForInputReady(opts.inputReadyTimeoutMs ?? 20000)
        if (opts.verifyPromptAfterResize && manager.isRunning && !signal?.aborted) {
            await verifyPromptAfterResize()
        }

        // A successful spawn() does not mean the agent reached a working prompt:
        // it can spawn and then exit before rendering one (bad config, invalid
        // args, auth failure). Distinguish that from a healthy start so onReady()
        // — which the caller uses to mark the session "ready" and to reset its
        // launch-failure breaker — only fires for a genuinely usable prompt. A
        // user abort during startup is a clean stop, not a failure.
        if (signal?.aborted) {
            return
        }
        if (!manager.isRunning) {
            throw new Error(`${opts.command} PTY exited before becoming ready`)
        }

        opts.onReady()

        while (manager.isRunning) {
            if (signal?.aborted) {
                logger.debug(`${debugPrefix} Aborted`)
                break
            }

            // In strict mode, do not remove a message from the queue until a
            // fresh interactive prompt exists. Between turns there is no fixed
            // deadline: a legitimate long agent run must not terminate HAPI.
            if (requirePromptMarker) {
                await waitForInputReady()
                await agentRunBoundaryTask
                if (!manager.isRunning || signal?.aborted) break
            }

            const next = await Promise.race([opts.nextMessage(), exited])
            if (next === EXITED) {
                logger.debug(`${debugPrefix} Process exited while waiting for message`)
                break
            }
            if (!next) {
                logger.debug(`${debugPrefix} No more input; waiting for process to finish`)
                break
            }

            if (!manager.isRunning) {
                logger.debug(`${debugPrefix} Process exited while waiting for message`)
                break
            }

            const cmd = parseSpecialCommand(next.message)
            if (cmd.type === 'clear' || cmd.type === 'compact') {
                logger.debug(`${debugPrefix} ${cmd.type} command - ignoring in PTY mode`)
                await opts.onMessageSkipped?.(next.message)
                continue
            }

            // Queue semantics: wait until output goes idle (agent back at the
            // prompt) before sending the next queued message.
            if (!requirePromptMarker) {
                await waitForInputReady(20000)
                await agentRunBoundaryTask
            }
            if (!manager.isRunning || signal?.aborted) {
                break
            }

            if (process.env.DEBUG_PTY) logger.debug(`${debugPrefix} write(loop): ${next.message}`)
            // The prompt is now consumed; the next queued message must wait for a
            // fresh prompt/idle marker rather than this same just-cleared one.
            await opts.onBeforeAgentRunStart?.()
            if (!manager.isRunning || signal?.aborted) break
            if (requirePromptMarker) {
                await waitForInputReady()
                if (!manager.isRunning || signal?.aborted) break
            }
            inputReady = false
            promptBuffer = ''
            agentRunActive = true
            agentRunSawBusyMarker = false
            await submitMessage(next.message)
            // The message has now been written to the PTY; let a caller verify it
            // actually landed (and repair it) without racing this submit path.
            await opts.onMessageSubmitted?.(next.message)
            // The agent is now working on this input — show "thinking" right away
            // (a busy marker reinforces it; the idle marker clears it when done).
            setThinking(true)
        }
    } finally {
        disarmIdleWatchdog()
        signal?.removeEventListener('abort', abortHandler)
        manager.kill()
        logger.debug(`${debugPrefix} PTY session ended`)
    }
}
