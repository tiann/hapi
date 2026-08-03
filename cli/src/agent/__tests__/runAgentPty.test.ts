import { afterEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => {
    let _isRunning = true
    let _onExit: ((code: number | null, signal: string | null) => void) | null = null
    let _onData: ((data: string) => void) | null = null
    let _onError: ((error: Error) => void) | null = null
    let _echo = true
    let _spawnError: Error | null = null

    const m = {
        get isRunning() { return _isRunning },
        spawn: vi.fn((opts: Record<string, unknown>) => {
            _onExit = (opts.onExit as typeof _onExit) ?? null
            _onData = (opts.onData as typeof _onData) ?? null
            _onError = (opts.onError as typeof _onError) ?? null
            // Simulate the manager reporting a spawn failure: onError fires and
            // the process never enters the running state.
            if (_spawnError) {
                _isRunning = false
                _onError?.(_spawnError)
            }
        }),
        // By default simulate the agent echoing keystrokes back as output so the
        // echo-confirm in runAgentPty proceeds on the first attempt.
        write: vi.fn((data: string) => {
            if (_echo) _onData?.(data)
        }),
        kill: vi.fn(() => { _isRunning = false }),
        resize: vi.fn(),
    }

    return {
        setRunning(v: boolean) { _isRunning = v },
        setEcho(v: boolean) { _echo = v },
        setSpawnError(err: Error | null) { _spawnError = err },
        triggerExit(code: number | null = 0, signal: string | null = null) {
            _isRunning = false
            _onExit?.(code, signal)
        },
        triggerData(data: string) { _onData?.(data) },
        reset() {
            _isRunning = true; _onExit = null; _onData = null; _onError = null; _echo = true; _spawnError = null
            m.spawn.mockClear(); m.write.mockClear(); m.kill.mockClear(); m.resize.mockClear()
        },
        m,
    }
})

vi.mock('@/agent/AgentPtyManager', () => ({
    AgentPtyManager: vi.fn(function() { return harness.m }),
}))
vi.mock('@/lib', () => ({ logger: { debug: vi.fn() } }))
vi.mock('@/parsers/specialCommands', () => ({
    parseSpecialCommand: (msg: string) => {
        if (msg === '/clear') return { type: 'clear' }
        if (msg === '/compact') return { type: 'compact' }
        return { type: 'message' }
    },
}))

import { runAgentPty } from '../runAgentPty'

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
    let resolve!: (v: T) => void
    return { promise: new Promise<T>((r) => { resolve = r }), resolve }
}

type Opts = Parameters<typeof runAgentPty>[0]
function makeOpts(overrides: Partial<Opts> = {}): Opts {
    return {
        command: 'testagent',
        args: [],
        cwd: '/tmp',
        debugPrefix: '[test]',
        idleReadyMs: 20,
        nextMessage: vi.fn(),
        onReady: vi.fn(),
        onMessage: vi.fn(),
        ...overrides,
    }
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

// Drive past the markerless waitForInputReady: emit output, then let the idle
// window + polling loop elapse.
async function reachReady() {
    harness.triggerData('boot')
    await tick(220)
}

describe('runAgentPty', () => {
    afterEach(() => { vi.useRealTimers(); harness.reset() })

    it('rejects (does not silently return) when the PTY fails to spawn', async () => {
        // A real failure such as `claude` not installed or the terminal failing
        // to attach: the manager reports onError and never enters running state.
        // runAgentPty must throw so the caller surfaces the error instead of
        // treating a never-started PTY as a clean exit and respawning.
        harness.setSpawnError(new Error('claude: command not found'))
        const nextMessage = vi.fn()
        const onReady = vi.fn()

        await expect(runAgentPty(makeOpts({ nextMessage, onReady })))
            .rejects.toThrow('claude: command not found')

        // It bailed before reaching the message loop / ready callback.
        expect(nextMessage).not.toHaveBeenCalled()
        expect(onReady).not.toHaveBeenCalled()
    })

    it('rejects with a generic error if spawn fails without an onError detail', async () => {
        harness.setRunning(false) // not running, but no onError fired
        const promise = runAgentPty(makeOpts({ command: 'mycli', nextMessage: vi.fn() }))
        await expect(promise).rejects.toThrow('Failed to spawn mycli PTY')
    })

    it('spawns with the given command/args/cwd and calls onReady', async () => {
        const msg = deferred<{ message: string } | null>()
        const onReady = vi.fn()
        const opts = makeOpts({ command: 'agy', args: ['--foo'], cwd: '/work', onReady, nextMessage: () => msg.promise })
        const promise = runAgentPty(opts)
        await tick(0)
        expect(harness.m.spawn).toHaveBeenCalled()
        const spawnArgs = harness.m.spawn.mock.calls[0][0] as { command: string; args: string[]; cwd: string }
        expect(spawnArgs.command).toBe('agy')
        expect(spawnArgs.args).toEqual(['--foo'])
        expect(spawnArgs.cwd).toBe('/work')
        // onReady fires only once the prompt is actually ready, not right after
        // spawn — so it has NOT been called yet here.
        expect(onReady).not.toHaveBeenCalled()
        await reachReady()
        expect(onReady).toHaveBeenCalled()
        msg.resolve(null)
        await promise
    })

    it('awaits agent-run completion work before submitting the next queued message', async () => {
        const completion = deferred<void>()
        const nextMessage = vi.fn()
            .mockResolvedValueOnce({ message: 'first' })
            .mockResolvedValueOnce({ message: 'second' })
            .mockResolvedValueOnce(null)
        const onAgentRunCompleted = vi.fn(() => completion.promise)
        const promise = runAgentPty(makeOpts({
            promptMarkers: ['READY'],
            busyMarkers: ['Generating'],
            idleMarkers: ['? for shortcuts'],
            nextMessage,
            onAgentRunCompleted,
        }))

        harness.triggerData('READY')
        await tick(220)
        expect(harness.m.write).toHaveBeenCalledWith('first')
        harness.triggerData('Generating...')
        harness.triggerData('? for shortcuts')
        await tick(20)
        expect(onAgentRunCompleted).toHaveBeenCalledTimes(1)
        expect(harness.m.write).not.toHaveBeenCalledWith('second')

        completion.resolve()
        await tick(220)
        expect(harness.m.write).toHaveBeenCalledWith('second')
        harness.triggerData('Generating...')
        harness.triggerData('? for shortcuts')
        await promise
    })

    it('closes the run boundary once when the silence watchdog fires before a late idle marker', async () => {
        vi.useFakeTimers()
        const completion = deferred<void>()
        const nextMessage = vi.fn()
            .mockResolvedValueOnce({ message: 'first' })
            .mockResolvedValueOnce({ message: 'second' })
            .mockResolvedValueOnce(null)
        const onAgentRunCompleted = vi.fn(() => completion.promise)
        const promise = runAgentPty(makeOpts({
            promptMarkers: ['READY'],
            busyMarkers: ['Generating'],
            idleMarkers: ['? for shortcuts'],
            requirePromptMarker: true,
            nextMessage,
            onAgentRunCompleted,
        }))

        harness.triggerData('READY')
        await vi.advanceTimersByTimeAsync(520)
        expect(harness.m.write).toHaveBeenCalledWith('first')
        harness.triggerData('Generating...')
        await vi.advanceTimersByTimeAsync(3000)
        expect(onAgentRunCompleted).toHaveBeenCalledTimes(1)
        expect(harness.m.write).not.toHaveBeenCalledWith('second')

        harness.triggerData('? for shortcuts')
        expect(onAgentRunCompleted).toHaveBeenCalledTimes(1)
        completion.resolve()
        await vi.advanceTimersByTimeAsync(520)
        expect(harness.m.write).toHaveBeenCalledWith('second')
        harness.triggerExit(0)
        await vi.advanceTimersByTimeAsync(100)
        await promise
        vi.useRealTimers()
    })

    it('does not let an armed silence watchdog complete a run after its idle marker already did', async () => {
        vi.useFakeTimers()
        const done = deferred<{ message: string } | null>()
        const onAgentRunCompleted = vi.fn()
        const promise = runAgentPty(makeOpts({
            promptMarkers: ['READY'],
            busyMarkers: ['Generating'],
            idleMarkers: ['? for shortcuts'],
            requirePromptMarker: true,
            nextMessage: vi.fn()
                .mockResolvedValueOnce({ message: 'first' })
                .mockImplementationOnce(() => done.promise),
            onAgentRunCompleted,
        }))

        harness.triggerData('READY')
        await vi.advanceTimersByTimeAsync(520)
        harness.triggerData('Generating...')
        harness.triggerData('? for shortcuts')
        expect(onAgentRunCompleted).toHaveBeenCalledTimes(1)
        await vi.advanceTimersByTimeAsync(3000)
        expect(onAgentRunCompleted).toHaveBeenCalledTimes(1)

        done.resolve(null)
        await promise
        vi.useRealTimers()
    })

    it('rejects (and never calls onReady) if the PTY exits before becoming ready', async () => {
        // Spawn succeeds, but the agent exits before rendering a usable prompt
        // (bad config, invalid args, auth failure). This must be treated as a
        // failure — not a ready session — so the caller's give-up breaker counts
        // it instead of respawning forever.
        const onReady = vi.fn()
        const nextMessage = vi.fn()
        const promise = runAgentPty(makeOpts({ command: 'mycli', onReady, nextMessage }))
        await tick(0)
        harness.triggerExit(1) // exits before any ready output

        await expect(promise).rejects.toThrow('mycli PTY exited before becoming ready')
        expect(onReady).not.toHaveBeenCalled()
        expect(nextMessage).not.toHaveBeenCalled()
    })

    it('injects envVars/extraEnv into the spawn env only (not process.env)', async () => {
        const msg = deferred<{ message: string } | null>()
        const opts = makeOpts({
            envVars: { FLAVOR_TOKEN: 'tok' },
            extraEnv: { CLAUDE_CONFIG_DIR: '/tmp/iso-cfg' },
            nextMessage: () => msg.promise,
        })
        const promise = runAgentPty(opts)
        await tick(0)
        const spawnEnv = (harness.m.spawn.mock.calls[0][0] as { env: Record<string, string> }).env
        expect(spawnEnv.FLAVOR_TOKEN).toBe('tok')
        expect(spawnEnv.CLAUDE_CONFIG_DIR).toBe('/tmp/iso-cfg')
        // TERM is always set so interactive TUI agents initialize (agy/bubbletea
        // drops to its login menu without it).
        expect(spawnEnv.TERM).toBeTruthy()
        // process.env must stay clean so the parent's scanner is unaffected.
        expect(process.env.CLAUDE_CONFIG_DIR).toBeUndefined()
        expect(process.env.FLAVOR_TOKEN).toBeUndefined()
        await reachReady()
        msg.resolve(null)
        await promise
    })

    it('removes unsetEnv keys from the spawn env (agy SSH_* stripping)', async () => {
        const msg = deferred<{ message: string } | null>()
        const opts = makeOpts({
            extraEnv: { SSH_AUTH_SOCK: '/run/user/1000/gnupg/S.gpg-agent.ssh', KEEP_ME: 'yes' },
            unsetEnv: ['SSH_AUTH_SOCK'],
            nextMessage: () => msg.promise,
        })
        const promise = runAgentPty(opts)
        await tick(0)
        const spawnEnv = (harness.m.spawn.mock.calls[0][0] as { env: Record<string, string> }).env
        // SSH_AUTH_SOCK is stripped so agy doesn't take its degraded "SSH session"
        // keyring path; unrelated vars are preserved.
        expect(spawnEnv.SSH_AUTH_SOCK).toBeUndefined()
        expect(spawnEnv.KEEP_ME).toBe('yes')
        await reachReady()
        msg.resolve(null)
        await promise
    })

    it('does NOT re-spawn for the transient login menu if the prompt renders within the settle window', async () => {
        // agy shows the login menu briefly on every startup while auth is in
        // flight, then renders the prompt. That must NOT count as a failure.
        const msg = deferred<{ message: string } | null>()
        const onAuthFailure = vi.fn()
        const opts = makeOpts({
            promptMarkers: ['for shortcuts'],
            authFailureMarkers: ['Select login method'],
            authSettleMs: 600,
            onAuthFailure,
            nextMessage: () => msg.promise,
        })
        const promise = runAgentPty(opts)
        await tick(0)
        harness.triggerData('Select login method: 1. Google OAuth') // transient
        await tick(120)
        harness.triggerData('? for shortcuts') // signed in within settle window
        await tick(700)
        expect(onAuthFailure).not.toHaveBeenCalled()
        msg.resolve(null)
        await promise
    })

    it('requests re-spawn (onAuthFailure) when still on the login menu past the settle window', async () => {
        const msg = deferred<{ message: string } | null>()
        const onAuthFailure = vi.fn()
        const opts = makeOpts({
            promptMarkers: ['for shortcuts'],
            authFailureMarkers: ['Select login method'],
            authSettleMs: 200,
            onAuthFailure,
            nextMessage: () => msg.promise,
        })
        const promise = runAgentPty(opts)
        await tick(0)
        harness.triggerData('Welcome. Select login method: 1. Google OAuth')
        await tick(500) // past the settle window, prompt never rendered
        expect(onAuthFailure).toHaveBeenCalledTimes(1)
        expect(harness.m.kill).toHaveBeenCalled()
        msg.resolve(null)
        await promise
    })

    it('auto-approves the trust prompt with Enter (not consuming the first message)', async () => {
        const msg = deferred<{ message: string } | null>()
        const opts = makeOpts({ trustMarkers: ['trust this folder'], nextMessage: () => msg.promise })
        const promise = runAgentPty(opts)
        await tick(0)
        // Agent shows the first-run trust screen.
        harness.triggerData('Quick safety check: Is this a project you trust this folder? 1. Yes')
        await tick(40)
        // Driver auto-approves with Enter (default highlight = Yes).
        expect(harness.m.write).toHaveBeenCalledWith('\r')
        msg.resolve(null)
        await promise
    })

    it('supports a RegExp promptMarker: ready only once the versioned banner renders', async () => {
        // agy's signed-in banner carries the CLI version ("Antigravity CLI 1.1.0"),
        // which a hard-coded string marker can't track across upgrades. A RegExp
        // marker (/Antigravity CLI \d/) must (a) NOT match the pre-auth welcome
        // line ("Antigravity CLI." — no version digit) and (b) mark ready once the
        // versioned banner appears — proving readiness comes from the marker, not
        // the 20 s startup hard-cap.
        const msg = deferred<{ message: string } | null>()
        const onReady = vi.fn()
        const opts = makeOpts({
            promptMarkers: [/Antigravity CLI \d/],
            idleReadyMs: 20,
            onReady,
            nextMessage: () => msg.promise,
        })
        const promise = runAgentPty(opts)
        await tick(0)
        // Pre-auth welcome: has "Antigravity CLI" but no version digit → not ready.
        harness.triggerData('Welcome to the Antigravity CLI. You are currently not signed in.')
        await tick(80)
        expect(onReady).not.toHaveBeenCalled()
        // Signed-in versioned banner → RegExp matches → ready well before any cap.
        harness.triggerData('▄▀▀▄        Antigravity CLI 1.1.0')
        await tick(120)
        expect(onReady).toHaveBeenCalled()
        msg.resolve(null)
        await promise
    })

    it('fails closed without dequeuing when a required prompt marker never appears', async () => {
        const nextMessage = vi.fn()
        const onReady = vi.fn()
        const promise = runAgentPty(makeOpts({
            command: 'agy',
            promptMarkers: ['? for shortcuts'],
            requirePromptMarker: true,
            inputReadyTimeoutMs: 100,
            nextMessage,
            onReady,
        }))

        harness.triggerData('▄▀▀▄        Antigravity CLI 1.1.8')

        await expect(promise).rejects.toThrow('agy PTY did not reach an interactive prompt')
        expect(onReady).not.toHaveBeenCalled()
        expect(nextMessage).not.toHaveBeenCalled()
    })

    it('recognizes a required prompt marker fragmented across output chunks', async () => {
        const msg = deferred<{ message: string } | null>()
        const nextMessage = vi.fn(() => msg.promise)
        const onReady = vi.fn()
        const promise = runAgentPty(makeOpts({
            promptMarkers: ['? for shortcuts'],
            requirePromptMarker: true,
            inputReadyTimeoutMs: 3000,
            idleReadyMs: 20,
            nextMessage,
            onReady,
        }))

        harness.triggerData('\x1b[2K? for sh')
        await tick(20)
        expect(onReady).not.toHaveBeenCalled()
        expect(nextMessage).not.toHaveBeenCalled()
        harness.triggerData('ortcuts\x1b[0m')
        await tick(120)

        expect(onReady).toHaveBeenCalledTimes(1)
        expect(nextMessage).toHaveBeenCalledTimes(1)
        msg.resolve(null)
        await promise
    })

    it('does not dequeue when resize does not redraw a fresh prompt', async () => {
        const nextMessage = vi.fn()
        const onReady = vi.fn()
        const promise = runAgentPty(makeOpts({
            command: 'agy',
            promptMarkers: ['? for shortcuts'],
            idleMarkers: ['? for shortcuts'],
            requirePromptMarker: true,
            verifyPromptAfterResize: true,
            inputReadyTimeoutMs: 500,
            idleReadyMs: 20,
            nextMessage,
            onReady,
        }))

        harness.triggerData('? for shortcuts')

        await expect(promise).rejects.toThrow('agy PTY did not reach an interactive prompt')
        expect(harness.m.resize).toHaveBeenCalledWith(79, 24)
        expect(harness.m.resize).toHaveBeenCalledWith(80, 24)
        expect(onReady).not.toHaveBeenCalled()
        expect(nextMessage).not.toHaveBeenCalled()
    })

    it('accepts a fragmented fresh prompt redrawn after resize', async () => {
        const msg = deferred<{ message: string } | null>()
        const nextMessage = vi.fn(() => msg.promise)
        const promise = runAgentPty(makeOpts({
            promptMarkers: ['? for shortcuts'],
            idleMarkers: ['? for shortcuts'],
            requirePromptMarker: true,
            verifyPromptAfterResize: true,
            inputReadyTimeoutMs: 500,
            idleReadyMs: 20,
            nextMessage,
        }))

        harness.triggerData('? for shortcuts')
        await tick(120)
        expect(harness.m.resize).toHaveBeenCalledWith(79, 24)
        harness.triggerData('? for sh')
        harness.triggerData('ortcuts')
        await tick(120)
        expect(nextMessage).toHaveBeenCalledTimes(1)
        expect(harness.m.write).not.toHaveBeenCalledWith(expect.stringContaining('hapi-ready-'))
        msg.resolve(null)
        await promise
    })

    it('restores the latest external terminal size after readiness verification', async () => {
        const msg = deferred<{ message: string } | null>()
        let controls!: { resize: (cols: number, rows: number) => void }
        const promise = runAgentPty(makeOpts({
            promptMarkers: ['? for shortcuts'],
            idleMarkers: ['? for shortcuts'],
            requirePromptMarker: true,
            verifyPromptAfterResize: true,
            inputReadyTimeoutMs: 500,
            idleReadyMs: 20,
            nextMessage: () => msg.promise,
            registerControls: (registered) => { controls = registered },
        }))

        harness.triggerData('? for shortcuts')
        await tick(120)
        controls.resize(120, 40)
        harness.triggerData('? for shortcuts')
        await tick(120)

        expect(harness.m.resize.mock.calls.at(-1)).toEqual([120, 40])
        msg.resolve(null)
        await promise
    })

    it('does not dequeue the next strict-mode message until the prompt returns', async () => {
        const first = deferred<{ message: string } | null>()
        const second = deferred<{ message: string } | null>()
        const nextMessage = vi.fn()
            .mockImplementationOnce(() => first.promise)
            .mockImplementationOnce(() => second.promise)
        const promise = runAgentPty(makeOpts({
            promptMarkers: ['? for shortcuts'],
            idleMarkers: ['? for shortcuts'],
            busyMarkers: ['Generating'],
            requirePromptMarker: true,
            inputReadyTimeoutMs: 500,
            idleReadyMs: 20,
            nextMessage,
        }))

        harness.triggerData('? for shortcuts')
        await tick(120)
        first.resolve({ message: 'first' })
        await tick(300)
        expect(harness.m.write).toHaveBeenCalledWith('first')

        harness.triggerData('Generating...')
        await tick(120)
        expect(nextMessage).toHaveBeenCalledTimes(1)

        harness.triggerData('? for sh')
        await tick(80)
        expect(nextMessage).toHaveBeenCalledTimes(1)
        harness.triggerData('ortcuts')
        await tick(120)
        expect(nextMessage).toHaveBeenCalledTimes(2)
        second.resolve(null)
        await promise
    })

    it('revalidates the prompt after an out-of-band PTY interaction', async () => {
        const queued = deferred<{ message: string } | null>()
        const done = deferred<{ message: string } | null>()
        let invalidateInputReady!: () => void
        const nextMessage = vi.fn()
            .mockImplementationOnce(() => queued.promise)
            .mockImplementationOnce(() => done.promise)
        const onBeforeAgentRunStart = vi.fn(async () => {
            invalidateInputReady()
            harness.triggerData('Model set to Gemini 3.5 Flash (Low)')
        })
        const promise = runAgentPty(makeOpts({
            promptMarkers: ['? for shortcuts'],
            idleMarkers: ['? for shortcuts'],
            requirePromptMarker: true,
            inputReadyTimeoutMs: 500,
            idleReadyMs: 20,
            nextMessage,
            onBeforeAgentRunStart,
            registerControls: (controls) => {
                invalidateInputReady = controls.invalidateInputReady
            },
        }))

        harness.triggerData('? for shortcuts')
        await tick(120)
        queued.resolve({ message: 'after picker' })
        await tick(120)
        expect(onBeforeAgentRunStart).toHaveBeenCalledTimes(1)
        expect(harness.m.write).not.toHaveBeenCalledWith('after picker')

        harness.triggerData('? for sh')
        harness.triggerData('ortcuts')
        await tick(300)
        expect(harness.m.write).toHaveBeenCalledWith('after picker')

        harness.triggerData('? for shortcuts')
        await tick(120)
        done.resolve(null)
        await promise
    })

    it('submits the first message only after ready, with CR separate from text', async () => {
        const msg1 = deferred<{ message: string } | null>()
        const msg2 = deferred<{ message: string } | null>()
        const nextMessage = vi.fn()
            .mockImplementationOnce(() => msg1.promise)
            .mockImplementationOnce(() => msg2.promise)
        const promise = runAgentPty(makeOpts({ nextMessage }))
        await reachReady()
        msg1.resolve({ message: 'hello' })
        await tick(300)
        // text then CR, as separate writes
        expect(harness.m.write).toHaveBeenCalledWith('hello')
        expect(harness.m.write).toHaveBeenCalledWith('\r')
        msg2.resolve(null)
        await promise
    })

    it('fires onMessageSubmitted after the write completes, once per real message (not for /clear)', async () => {
        const msg1 = deferred<{ message: string } | null>()
        const msg2 = deferred<{ message: string } | null>()
        const msg3 = deferred<{ message: string } | null>()
        const nextMessage = vi.fn()
            .mockImplementationOnce(() => msg1.promise)
            .mockImplementationOnce(() => msg2.promise)
            .mockImplementationOnce(() => msg3.promise)
        const onMessageSubmitted = vi.fn()
        const promise = runAgentPty(makeOpts({ nextMessage, onMessageSubmitted }))
        await reachReady()

        // /clear is dropped before the submit path → no post-submit callback,
        // so a first-message verifier armed here would never fire on a no-op.
        msg1.resolve({ message: '/clear' })
        await tick(60)
        expect(onMessageSubmitted).not.toHaveBeenCalled()

        // A real message fires the callback exactly once, AFTER text + CR were
        // written — the contract that stops a verifier racing the submit.
        msg2.resolve({ message: 'hello' })
        await tick(300)
        expect(onMessageSubmitted).toHaveBeenCalledTimes(1)
        expect(onMessageSubmitted).toHaveBeenCalledWith('hello')
        const lastWriteOrder = Math.max(...harness.m.write.mock.invocationCallOrder)
        expect(onMessageSubmitted.mock.invocationCallOrder[0]).toBeGreaterThan(lastWriteOrder)

        msg3.resolve(null)
        await promise
    })

    it('arms quota observation after an outgoing echo and delivers an idle-footer quota frame before completion', async () => {
        const quotaFrame = "Individual quota reached. Please upgrade your subscription to increase your limits. Error ID: f5bb4da7-3689-4eca-b1ea-fd171bae4f71-215 How's the CLI experience so far? Help us improve: ? for shortcuts"
        const done = deferred<{ message: string } | null>()
        const observedQuotaFrames: string[] = []
        let quotaDetectorArmed = false
        const onMessage = vi.fn((data: string) => {
            if (quotaDetectorArmed && data === quotaFrame) observedQuotaFrames.push(data)
        })
        const onBeforeMessageSubmit = vi.fn(() => { quotaDetectorArmed = true })
        const onAgentRunCompleted = vi.fn(() => { quotaDetectorArmed = false })
        const nextMessage = vi.fn()
            .mockResolvedValueOnce({ message: quotaFrame })
            .mockImplementationOnce(() => done.promise)
        const promise = runAgentPty(makeOpts({
            promptMarkers: ['? for shortcuts'],
            busyMarkers: ['Generating'],
            idleMarkers: ['? for shortcuts'],
            requirePromptMarker: true,
            idleReadyMs: 20,
            nextMessage,
            onMessage,
            onBeforeMessageSubmit,
            onAgentRunCompleted,
        }))

        harness.triggerData('? for shortcuts')
        await tick(120)
        await tick(300)

        // The queued text is echoed before onBeforeMessageSubmit, so an exact
        // user quote cannot be mistaken for an agent quota failure.
        const echoedQuotaCall = onMessage.mock.calls.findIndex(([data]) => data === quotaFrame)
        expect(echoedQuotaCall).toBeGreaterThanOrEqual(0)
        expect(observedQuotaFrames).toEqual([])
        expect(onBeforeMessageSubmit).toHaveBeenCalledWith(quotaFrame)
        expect(onBeforeMessageSubmit.mock.invocationCallOrder[0])
            .toBeGreaterThan(onMessage.mock.invocationCallOrder[echoedQuotaCall])
        expect(quotaDetectorArmed).toBe(true)
        expect(onAgentRunCompleted).not.toHaveBeenCalled()

        harness.triggerData('Generating...')
        harness.triggerData(quotaFrame)

        // onMessage must see the idle-footer frame while armed; completion
        // disarms only after the same raw chunk reaches the consumer.
        expect(onMessage).toHaveBeenLastCalledWith(quotaFrame)
        expect(observedQuotaFrames).toEqual([quotaFrame])
        expect(onAgentRunCompleted).toHaveBeenCalledTimes(1)
        expect(onAgentRunCompleted.mock.invocationCallOrder[0])
            .toBeGreaterThan(onMessage.mock.invocationCallOrder.at(-1)!)

        done.resolve(null)
        await promise
    })

    it('bracketed-paste wraps a multiline message so only the final CR submits', async () => {
        const msg1 = deferred<{ message: string } | null>()
        const msg2 = deferred<{ message: string } | null>()
        const nextMessage = vi.fn()
            .mockImplementationOnce(() => msg1.promise)
            .mockImplementationOnce(() => msg2.promise)
        const promise = runAgentPty(makeOpts({ nextMessage }))
        await reachReady()
        // e.g. an attachment-formatted prompt or a batched queue flush.
        msg1.resolve({ message: '@/tmp/a.png\n\ndescribe this' })
        await tick(300)
        // The whole block is written once, bracketed — embedded newlines stay
        // literal instead of each acting as Enter.
        expect(harness.m.write).toHaveBeenCalledWith('\x1b[200~@/tmp/a.png\n\ndescribe this\x1b[201~')
        // The raw (unbracketed) multiline text must never be written.
        expect(harness.m.write).not.toHaveBeenCalledWith('@/tmp/a.png\n\ndescribe this')
        // Exactly one CR submits the whole paste.
        const crWrites = harness.m.write.mock.calls.filter((c) => c[0] === '\r').length
        expect(crWrites).toBe(1)
        msg2.resolve(null)
        await promise
    })

    it('does not bracket a single-line message', async () => {
        const msg1 = deferred<{ message: string } | null>()
        const msg2 = deferred<{ message: string } | null>()
        const nextMessage = vi.fn()
            .mockImplementationOnce(() => msg1.promise)
            .mockImplementationOnce(() => msg2.promise)
        const promise = runAgentPty(makeOpts({ nextMessage }))
        await reachReady()
        msg1.resolve({ message: 'hello world' })
        await tick(300)
        expect(harness.m.write).toHaveBeenCalledWith('hello world')
        expect(harness.m.write).not.toHaveBeenCalledWith('\x1b[200~hello world\x1b[201~')
        msg2.resolve(null)
        await promise
    })

    it('retries the write when the agent does not echo (stdin not ready yet)', async () => {
        const msg1 = deferred<{ message: string } | null>()
        const msg2 = deferred<{ message: string } | null>()
        const nextMessage = vi.fn()
            .mockImplementationOnce(() => msg1.promise)
            .mockImplementationOnce(() => msg2.promise)
        const promise = runAgentPty(makeOpts({ nextMessage }))
        await reachReady()
        harness.setEcho(false) // agent ignores input → no echo
        msg1.resolve({ message: 'hi' })
        await tick(2500) // 3 attempts × 700ms echo wait
        const textWrites = harness.m.write.mock.calls.filter((c) => c[0] === 'hi').length
        expect(textWrites).toBe(3)
        msg2.resolve(null)
        harness.setRunning(false)
        await promise
    })

    it('ignores /clear and /compact in the loop', async () => {
        const msg1 = deferred<{ message: string } | null>()
        const msg2 = deferred<{ message: string } | null>()
        const msg3 = deferred<{ message: string } | null>()
        const nextMessage = vi.fn()
            .mockImplementationOnce(() => msg1.promise)
            .mockImplementationOnce(() => msg2.promise)
            .mockImplementationOnce(() => msg3.promise)
        const promise = runAgentPty(makeOpts({ nextMessage }))
        await reachReady()
        msg1.resolve({ message: '/clear' })
        await tick(60)
        expect(harness.m.write).not.toHaveBeenCalledWith('/clear')
        msg2.resolve({ message: '/compact' })
        await tick(60)
        expect(harness.m.write).not.toHaveBeenCalledWith('/compact')
        msg3.resolve(null)
        await promise
    })

    it('awaits skipped-message cleanup before dequeuing the next prompt', async () => {
        const msg1 = deferred<{ message: string } | null>()
        const msg2 = deferred<{ message: string } | null>()
        const cleanup = deferred<void>()
        const nextMessage = vi.fn()
            .mockImplementationOnce(() => msg1.promise)
            .mockImplementationOnce(() => msg2.promise)
        const onMessageSkipped = vi.fn(() => cleanup.promise)
        const promise = runAgentPty(makeOpts({ nextMessage, onMessageSkipped }))
        await reachReady()

        msg1.resolve({ message: '/clear' })
        await tick(60)
        expect(onMessageSkipped).toHaveBeenCalledWith('/clear')
        expect(nextMessage).toHaveBeenCalledTimes(1)

        cleanup.resolve()
        await tick(60)
        expect(nextMessage).toHaveBeenCalledTimes(2)
        msg2.resolve(null)
        await promise
    })

    it('stops and kills on exit', async () => {
        const msg1 = deferred<{ message: string } | null>()
        const onExit = vi.fn()
        const nextMessage = vi.fn().mockImplementationOnce(() => msg1.promise)
        const promise = runAgentPty(makeOpts({ nextMessage, onExit }))
        await reachReady()
        harness.triggerExit(0)
        await expect(promise).resolves.toBeUndefined()
        expect(onExit).toHaveBeenCalledWith(0)
        expect(harness.m.kill).toHaveBeenCalled()
    })

    it('aborts via signal', async () => {
        const msg1 = deferred<{ message: string } | null>()
        const msg2 = deferred<{ message: string } | null>()
        const controller = new AbortController()
        const nextMessage = vi.fn()
            .mockImplementationOnce(() => msg1.promise)
            .mockImplementationOnce(() => msg2.promise)
        const promise = runAgentPty(makeOpts({ nextMessage, signal: controller.signal }))
        await reachReady()
        msg1.resolve({ message: 'first' })
        await tick(120)
        controller.abort()
        msg2.resolve({ message: 'should not send' })
        await promise
        expect(harness.m.write).not.toHaveBeenCalledWith('should not send')
        expect(harness.m.kill).toHaveBeenCalled()
    })
})
