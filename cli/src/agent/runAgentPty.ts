import { AgentPtyManager } from "@/agent/AgentPtyManager"
import { parseSpecialCommand } from "@/parsers/specialCommands"
import { bracketPasteIfMultiline } from "@/agent/bracketedPaste"
import { logger } from "@/lib"

/**
 * Shared driver for running an interactive agent CLI (e.g. claude) inside a
 * PTY. All flavor-specific behavior is supplied via options:
 *  - `command` / `args` / `cwd` / `envVars` / `extraEnv` — how to spawn
 *  - `promptMarkers` — strings that indicate the agent's input prompt has
 *    rendered. When provided, input-ready is gated on seeing one of them (e.g.
 *    claude's ink TUI). When omitted, falls back to an output-idle heuristic
 *    (for an agent with no detectable prompt marker).
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
     * Env var names to REMOVE from the spawned process's environment. claude uses
     * this to strip CLAUDECODE / CLAUDE_CODE_* so the child isn't mistaken for a
     * nested session (which would stop it writing its JSONL transcript).
     */
    unsetEnv?: string[]
    /** Output substrings that signal the input prompt has rendered. */
    promptMarkers?: string[]
    /**
     * Output substrings that indicate a trust/safety prompt the agent shows on
     * first run in a folder (e.g. claude's "Is this a project you trust?").
     * When detected, the driver auto-approves it (Enter selects the default
     * "Yes" option) so the trust screen doesn't get mistaken for the input
     * prompt and the first user message isn't consumed by it.
     */
    trustMarkers?: string[]
    /** Idle window (ms) used to decide output has settled. */
    idleReadyMs?: number
    /**
     * Output substrings shown while the agent is actively working (e.g. claude's
     * "esc to interrupt" footer / spinner). When seen, `onThinkingChange(true)`.
     */
    busyMarkers?: string[]
    /**
     * Output substrings shown when the agent is back at an idle input prompt
     * (e.g. claude's "for shortcuts" hint). When seen, `onThinkingChange(false)`.
     */
    idleMarkers?: string[]
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
    /**
     * Called once the PTY is spawned with controls for the live terminal. The
     * agent-terminal viewer uses `resize` to repaint the TUI on (re)subscribe so
     * the current screen is shown instead of a stale/black buffer replay. Controls
     * become no-ops after the process exits.
     */
    registerControls?: (controls: { resize: (cols: number, rows: number) => void; sendKeys: (data: string) => void }) => void
}

export async function runAgentPty(opts: RunAgentPtyOpts): Promise<void> {
    const { debugPrefix } = opts
    logger.debug(`${debugPrefix} Starting PTY session`)

    // Flavor env vars are injected into the spawned process's environment ONLY —
    // never into this process's process.env. This keeps CLAUDE_CONFIG_DIR (used
    // by claudePty to isolate folder-trust) scoped to the child, so the parent's
    // session scanner still resolves transcripts against the real ~/.claude.
    const spawnEnv = {
        ...process.env,
        // PTY agents with a full TUI need TERM set — the runner's Bun.spawn env
        // lacks it. Default to a sane terminal so the interactive TUI initializes
        // correctly.
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

    const markers = opts.promptMarkers ?? []
    const hasMarkers = markers.length > 0
    const trustMarkers = opts.trustMarkers ?? []
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
    // Whether the first-run trust/safety prompt has been auto-approved.
    let trustHandled = false

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
    // really over → force idle. Scoped to agents with a busy marker (claude).
    const IDLE_SILENCE_MS = 3000
    let idleWatchdog: ReturnType<typeof setTimeout> | null = null
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
    // idle alone. A longer-idle fallback prevents hanging if a marker never
    // matches (UI change).
    const waitForInputReady = async (timeoutMs = 20000): Promise<void> => {
        const start = Date.now()
        while (Date.now() - start < timeoutMs) {
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
        manager.write('\r')
        await sleep(50)
    }

    const abortHandler = () => {
        logger.debug(`${debugPrefix} Abort signal received`)
        manager.kill()
    }
    signal?.addEventListener('abort', abortHandler, { once: true })

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
                sawOutput = true
                lastOutputAt = Date.now()
                // Auto-approve the first-run trust/safety prompt (Enter = default
                // "Yes"). Do this BEFORE prompt detection so the trust screen
                // isn't mistaken for the input prompt — otherwise the first user
                // message gets consumed as the trust answer.
                if (!trustHandled && trustMarkers.length > 0 && trustMarkers.some((m) => data.includes(m))) {
                    trustHandled = true
                    logger.debug(`${debugPrefix} trust prompt detected; auto-approving with Enter`)
                    manager.write('\r')
                } else if (hasMarkers && !promptSeen && markers.some((m) => data.includes(m))) {
                    promptSeen = true
                    inputReady = true
                }
                // Track the working/idle state from the live footer. The busy
                // marker (spinner/"esc to interrupt") wins when both appear in a
                // chunk; chunks with neither leave the state unchanged.
                if (busyMarkers.length > 0 && busyMarkers.some((m) => data.includes(m))) {
                    setThinking(true)
                    inputReady = false
                } else if (idleMarkers.length > 0 && idleMarkers.some((m) => data.includes(m))) {
                    setThinking(false)
                    inputReady = true
                } else if (thinking) {
                    // Still producing output (e.g. streaming response text with no
                    // footer marker in this chunk) — keep the silence watchdog at bay.
                    armIdleWatchdog()
                }
                if (process.env.DEBUG_PTY) logger.debug(`${debugPrefix} onData: ${data.length} bytes`)
                opts.onMessage(data)
            },
            onExit: (code) => {
                logger.debug(`${debugPrefix} Process exited with code ${code}`)
                setThinking(false)
                opts.onExit?.(code)
            },
            onError: (error) => {
                spawnError = error
                logger.debug(`${debugPrefix} PTY error: ${error.message}`, error)
            },
        })

        if (!manager.isRunning) {
            // Surface the failure instead of returning as if it succeeded —
            // otherwise the caller (e.g. ClaudePtyLauncher) treats a never-started
            // PTY as a clean exit and silently respawns, hiding real errors like
            // `claude` not being installed or the terminal failing to attach.
            throw spawnError ?? new Error(`Failed to spawn ${opts.command} PTY`)
        }

        opts.registerControls?.({
            resize: (cols: number, rows: number) => {
                if (!manager.isRunning) return
                if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) return
                manager.resize(cols, rows)
            },
            // Inject raw keystrokes into the live TUI — used to drive in-place
            // settings changes (e.g. claude's `/model`/`/effort` slash commands)
            // without re-spawning the process.
            sendKeys: (data: string) => {
                if (!manager.isRunning || !data) return
                manager.write(data)
            }
        })

        // Wait until the prompt is actually usable BEFORE any message arrives, so
        // the first user message is processed immediately instead of being
        // consumed as the spawn trigger.
        await waitForInputReady()

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

            const next = await opts.nextMessage()
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
                continue
            }

            // Queue semantics: wait until output goes idle (agent back at the
            // prompt) before sending the next queued message.
            await waitForInputReady()
            if (!manager.isRunning || signal?.aborted) {
                break
            }

            if (process.env.DEBUG_PTY) logger.debug(`${debugPrefix} write(loop): ${next.message}`)
            // The prompt is now consumed; the next queued message must wait for a
            // fresh prompt/idle marker rather than this same just-cleared one.
            inputReady = false
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
