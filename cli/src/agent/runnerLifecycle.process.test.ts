import { describe, it, expect, afterEach } from 'vitest'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

type SpawnedChild = ChildProcessByStdio<null, Readable, Readable>

// Killing the PTY (which sends SIGHUP) must leave the process alive.
// A same-process `process.emit('SIGHUP')` (as in runnerLifecycle.test.ts)
// only proves the listener runs — it says nothing about whether that
// listener actually beats the kernel's default terminate-on-SIGHUP
// disposition, which is the entire point of registering a handler at all.
// This suite spawns a *real* child process, sends it a *real* SIGHUP via
// process.kill(pid, 'SIGHUP'), and asserts the OS process is still alive
// afterwards. No PTY/node-pty dependency is needed: SIGHUP's default
// disposition and a handler's ability to override it are process-signal
// mechanics, not TTY mechanics — the PTY is only how the terminal-close
// case *generates* SIGHUP in production; the test can generate it directly.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CHILD_SCRIPT = path.join(__dirname, '__fixtures__/runnerLifecycleProcessChild.ts')
const CHILD_SCRIPT_NO_OPT_IN = path.join(__dirname, '__fixtures__/runnerLifecycleProcessChildNoOptIn.ts')

function waitForLine(
    child: SpawnedChild,
    predicate: (line: string) => boolean,
    timeoutMs = 5000
): Promise<string> {
    return new Promise((resolve, reject) => {
        let buffer = ''
        const timer = setTimeout(() => {
            reject(new Error(`Timed out waiting for line matching predicate. Output so far:\n${buffer}`))
        }, timeoutMs)
        const onData = (chunk: Buffer) => {
            buffer += chunk.toString('utf8')
            const lines = buffer.split('\n')
            for (const line of lines) {
                if (predicate(line)) {
                    clearTimeout(timer)
                    child.stdout.off('data', onData)
                    resolve(line)
                    return
                }
            }
        }
        child.stdout.on('data', onData)
    })
}

function isAlive(pid: number): boolean {
    try {
        // Signal 0 does not actually send a signal — it just probes whether
        // the process (and our permission to signal it) still exists.
        process.kill(pid, 0)
        return true
    } catch {
        return false
    }
}

// POSIX-only: Windows emulates SIGHUP on console close but the OS then
// terminates the process unconditionally after a short grace period, and
// process.kill(pid, 'SIGHUP') kills outright there — the survival contract
// under test only holds on POSIX hosts (upstream CI runs ubuntu).
describe.skipIf(process.platform === 'win32')('runnerLifecycle SIGHUP process survival (integration)', { timeout: 15_000 }, () => {
    let child: SpawnedChild | null = null

    afterEach(() => {
        if (child && child.pid && isAlive(child.pid)) {
            child.kill('SIGKILL')
        }
        child = null
    })

    it('stays alive after SIGHUP and never reports an archive/session-death', async () => {
        const proc = spawn('bun', ['run', CHILD_SCRIPT], {
            stdio: ['ignore', 'pipe', 'pipe']
        })
        child = proc
        const pid = proc.pid
        expect(pid).toBeDefined()

        let stdout = ''
        proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
        let stderr = ''
        proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })

        await waitForLine(proc, (line) => line.trim() === 'READY')

        process.kill(pid!, 'SIGHUP')

        // Give the (incorrectly, if this regresses) default disposition —
        // or an async crash from an unguarded stream write — time to kill
        // the process before we assert it is still up.
        await new Promise((resolve) => setTimeout(resolve, 1000))

        expect(isAlive(pid!)).toBe(true)
        expect(stdout).not.toContain('EVENT sendSessionDeath')
        expect(stdout).not.toContain('EVENT close')
        // Not `expect(stderr).toBe('')` — that's brittle against any
        // incidental warning a future dependency bump might print (a
        // deprecation notice, a runtime version banner, etc.), which would
        // fail this test for reasons that have nothing to do with SIGHUP
        // survival. What actually matters here is that surviving SIGHUP
        // didn't itself crash the process — assert on the absence of
        // crash/error signatures, not on total silence.
        expect(stderr).not.toMatch(/uncaught|unhandled|panic|segmentation fault/i)
        expect(stderr).not.toContain('Error:')
    })

    it('without the opt-in, SIGHUP falls through to the platform default and the process dies', async () => {
        const proc = spawn('bun', ['run', CHILD_SCRIPT_NO_OPT_IN], {
            stdio: ['ignore', 'pipe', 'pipe']
        })
        child = proc
        const pid = proc.pid
        expect(pid).toBeDefined()

        const exited = new Promise<void>((resolve) => {
            proc.once('exit', () => resolve())
        })

        await waitForLine(proc, (line) => line.trim() === 'READY')

        process.kill(pid!, 'SIGHUP')

        await Promise.race([
            exited,
            new Promise((_, reject) => setTimeout(() => reject(new Error('un-opted-in child did not die on SIGHUP within the timeout')), 5000))
        ])

        expect(isAlive(pid!)).toBe(false)
    })

    it('HAPI_EXIT_ON_HANGUP=1: SIGHUP archives gracefully and the process exits', async () => {
        const proc = spawn('bun', ['run', CHILD_SCRIPT], {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, HAPI_EXIT_ON_HANGUP: '1' }
        })
        child = proc
        const pid = proc.pid
        expect(pid).toBeDefined()

        let stdout = ''
        proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })

        const exited = new Promise<void>((resolve) => {
            proc.once('exit', () => resolve())
        })

        await waitForLine(proc, (line) => line.trim() === 'READY')

        process.kill(pid!, 'SIGHUP')

        await Promise.race([
            exited,
            new Promise((_, reject) => setTimeout(() => reject(new Error('child did not exit after SIGHUP with HAPI_EXIT_ON_HANGUP=1')), 5000))
        ])

        expect(isAlive(pid!)).toBe(false)
        expect(stdout).toContain('EVENT sendSessionDeath')
        expect(stdout).toContain('EVENT close')
        expect(stdout).toMatch(/EVENT updateMetadata .*"lifecycleState":"archived"/)
        expect(stdout).toMatch(/EVENT updateMetadata .*"archiveReason":"SIGHUP/)
    })
})
