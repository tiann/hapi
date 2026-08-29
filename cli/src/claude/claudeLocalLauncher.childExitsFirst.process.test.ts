import { describe, it, expect, afterEach } from 'vitest'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

type SpawnedChild = ChildProcessByStdio<null, Readable, Readable>

// Addresses the Major finding from the automated review on this PR: terminal
// close sends SIGHUP to the whole foreground process group, but there is no
// guaranteed ordering between the parent's SIGHUP callback and the local
// claude child's exit callback — both of which want to know whether the
// terminal is gone. If the child's exit callback runs first and only reads
// the synchronous isTerminalLost() flag, it can classify the exit as a
// genuine user /exit and end the session instead of switching to remote.
//
// This suite proves the fix closes that race using two real, independently
// signalled OS processes (a same-process `process.emit('SIGHUP')` test only
// proves a listener ran, not that it wins or loses a real ordering race):
// the "grandchild" plays the local claude process, the "parent" fixture
// plays claudeLocalLauncher's classification logic. The child is made to
// exit first; the parent's own SIGHUP is delivered only after that, still
// inside the wait window.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PARENT_SCRIPT = path.join(__dirname, '__fixtures__/claudeLocalLauncherRaceParent.ts')

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
        process.kill(pid, 0)
        return true
    } catch {
        return false
    }
}

// POSIX-only, same rationale as runnerLifecycle.process.test.ts: the SIGHUP
// survival/ordering contract under test only holds on POSIX hosts (upstream
// CI runs ubuntu).
describe.skipIf(process.platform === 'win32')('claudeLocalLauncher child-exits-first SIGHUP ordering (integration)', { timeout: 15_000 }, () => {
    let parent: SpawnedChild | null = null

    afterEach(() => {
        if (parent && parent.pid && isAlive(parent.pid)) {
            parent.kill('SIGKILL')
        }
        parent = null
    })

    it('child dies first, parent SIGHUP lands within the wait window: classification is switch', async () => {
        const proc = spawn('bun', ['run', PARENT_SCRIPT], {
            stdio: ['ignore', 'pipe', 'pipe']
        })
        parent = proc
        const parentPid = proc.pid
        expect(parentPid).toBeDefined()

        let stderr = ''
        proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })

        const pidLine = await waitForLine(proc, (line) => line.startsWith('GRANDCHILD_PID '))
        const grandchildPid = Number(pidLine.replace('GRANDCHILD_PID ', '').trim())
        expect(grandchildPid).toBeGreaterThan(0)

        await waitForLine(proc, (line) => line.trim() === 'READY')

        // Child exits first...
        process.kill(grandchildPid, 'SIGHUP')
        // ...and the parent's own SIGHUP — the signal that calls the real
        // markTerminalLost() — is only delivered afterwards, but still well
        // inside the 100ms wait window claudeLocalLauncher.ts gives it.
        await new Promise((resolve) => setTimeout(resolve, 20))
        process.kill(parentPid!, 'SIGHUP')

        const classification = await waitForLine(proc, (line) => line.startsWith('CLASSIFICATION '))
        expect(classification.trim()).toBe('CLASSIFICATION switch')
        expect(stderr).not.toMatch(/uncaught|unhandled|panic|segmentation fault/i)
    })

    it('child dies first, no parent SIGHUP ever arrives: classification falls back to exit after the window (control)', async () => {
        const proc = spawn('bun', ['run', PARENT_SCRIPT], {
            stdio: ['ignore', 'pipe', 'pipe']
        })
        parent = proc
        const parentPid = proc.pid
        expect(parentPid).toBeDefined()

        const pidLine = await waitForLine(proc, (line) => line.startsWith('GRANDCHILD_PID '))
        const grandchildPid = Number(pidLine.replace('GRANDCHILD_PID ', '').trim())
        expect(grandchildPid).toBeGreaterThan(0)

        await waitForLine(proc, (line) => line.trim() === 'READY')

        process.kill(grandchildPid, 'SIGHUP')
        // Deliberately never signal the parent — this is the control that
        // proves the "switch" result above is actually caused by the
        // parent's (delayed) SIGHUP landing in time, not by
        // waitForTerminalLoss always resolving true regardless of timing.

        const classification = await waitForLine(proc, (line) => line.startsWith('CLASSIFICATION '), 5000)
        expect(classification.trim()).toBe('CLASSIFICATION exit')
        expect(isAlive(parentPid!)).toBe(true)
    })
})
