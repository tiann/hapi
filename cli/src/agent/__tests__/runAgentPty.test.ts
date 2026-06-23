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
    afterEach(() => { harness.reset() })

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
        const opts = makeOpts({ command: 'mycli', args: ['--foo'], cwd: '/work', onReady, nextMessage: () => msg.promise })
        const promise = runAgentPty(opts)
        await tick(0)
        expect(harness.m.spawn).toHaveBeenCalled()
        const spawnArgs = harness.m.spawn.mock.calls[0][0] as { command: string; args: string[]; cwd: string }
        expect(spawnArgs.command).toBe('mycli')
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
        // TERM is always set so interactive TUI agents initialize correctly.
        expect(spawnEnv.TERM).toBeTruthy()
        // process.env must stay clean so the parent's scanner is unaffected.
        expect(process.env.CLAUDE_CONFIG_DIR).toBeUndefined()
        expect(process.env.FLAVOR_TOKEN).toBeUndefined()
        await reachReady()
        msg.resolve(null)
        await promise
    })

    it('removes unsetEnv keys from the spawn env (CLAUDECODE stripping)', async () => {
        const msg = deferred<{ message: string } | null>()
        const opts = makeOpts({
            extraEnv: { CLAUDECODE: '1', KEEP_ME: 'yes' },
            unsetEnv: ['CLAUDECODE'],
            nextMessage: () => msg.promise,
        })
        const promise = runAgentPty(opts)
        await tick(0)
        const spawnEnv = (harness.m.spawn.mock.calls[0][0] as { env: Record<string, string> }).env
        // CLAUDECODE is stripped so the child claude isn't treated as a nested
        // session (which stops it writing its transcript); unrelated vars are kept.
        expect(spawnEnv.CLAUDECODE).toBeUndefined()
        expect(spawnEnv.KEEP_ME).toBe('yes')
        await reachReady()
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

    it('stops and kills on exit', async () => {
        const msg1 = deferred<{ message: string } | null>()
        const onExit = vi.fn()
        const nextMessage = vi.fn().mockImplementationOnce(() => msg1.promise)
        const promise = runAgentPty(makeOpts({ nextMessage, onExit }))
        await reachReady()
        harness.triggerExit(0)
        msg1.resolve({ message: 'late' })
        await promise
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

    it('holds a queued message until a fresh prompt marker (not a mid-turn gap)', async () => {
        const msg1 = deferred<{ message: string } | null>()
        const msg2 = deferred<{ message: string } | null>()
        const nextMessage = vi.fn()
            .mockImplementationOnce(() => msg1.promise)
            .mockImplementationOnce(() => msg2.promise)
            .mockImplementation(() => Promise.resolve(null))
        const promise = runAgentPty(makeOpts({
            nextMessage,
            promptMarkers: ['for shortcuts'],
            busyMarkers: ['esc to interrupt'],
            idleMarkers: ['for shortcuts'],
            idleReadyMs: 20,
        }))

        // Reach the first usable prompt, then let the first message submit.
        harness.triggerData('? for shortcuts')
        await tick(120)
        msg1.resolve({ message: 'first' })
        await tick(120)
        expect(harness.m.write).toHaveBeenCalledWith('first')

        // Turn is running: busy marker, then a quiet gap with NO idle marker.
        harness.triggerData('working hard… esc to interrupt')
        msg2.resolve({ message: 'second' })
        await tick(200) // exceeds idleReadyMs of silence, but the prompt has not returned
        expect(harness.m.write).not.toHaveBeenCalledWith('second')

        // The prompt returns (idle marker) → the queued message may now be sent.
        harness.triggerData('? for shortcuts')
        await tick(150)
        expect(harness.m.write).toHaveBeenCalledWith('second')

        await promise.catch(() => {})
    })

    it('does not submit a queued message while a long turn keeps emitting busy output', async () => {
        const msg1 = deferred<{ message: string } | null>()
        const msg2 = deferred<{ message: string } | null>()
        const nextMessage = vi.fn()
            .mockImplementationOnce(() => msg1.promise)
            .mockImplementationOnce(() => msg2.promise)
            .mockImplementation(() => Promise.resolve(null))
        const promise = runAgentPty(makeOpts({
            nextMessage,
            promptMarkers: ['for shortcuts'],
            busyMarkers: ['esc to interrupt'],
            idleMarkers: ['for shortcuts'],
            idleReadyMs: 20,
        }))

        harness.triggerData('? for shortcuts')
        await tick(120)
        msg1.resolve({ message: 'first' })
        await tick(120)
        expect(harness.m.write).toHaveBeenCalledWith('first')

        // A long turn: keep emitting busy output well past idleReadyMs. There is
        // no fixed readiness timeout, so the queued message must keep waiting and
        // never be typed into the busy TUI.
        harness.triggerData('thinking… esc to interrupt')
        msg2.resolve({ message: 'second' })
        for (let i = 0; i < 8; i++) {
            await tick(50)
            harness.triggerData('still working… esc to interrupt')
        }
        expect(harness.m.write).not.toHaveBeenCalledWith('second')

        // Turn ends (idle marker) → the queued message is finally submitted.
        harness.triggerData('? for shortcuts')
        await tick(150)
        expect(harness.m.write).toHaveBeenCalledWith('second')

        await promise.catch(() => {})
    })
})
