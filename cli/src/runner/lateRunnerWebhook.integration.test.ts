import { describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { getProcessStartMarker } from '@/utils/process'
import { TEST_OWNED_MARKER_KEY } from '@/test/integrationEnv'

/**
 * Drives a real runner over its control server with a synthetic child that
 * stands in for a CLI whose webhook arrives while the runner has no tracking
 * entry for its PID (runner restart, or a webhook that outlived its sender).
 * Adoption persists the PID's start marker for the stopSession generation
 * check, so the webhook must prove it comes from the process that owns the
 * PID right now (decideUntrackedRunnerWebhook). Start markers come from
 * `ps`, so the suite is POSIX only, like the shared Codex full stack test.
 */

type RunnerState = { pid: number; httpPort: number }
type ResumeRecord = { requestedSessionId: string; confirmedSessionId?: string; pid: number; processStartMarker: string }

async function until<T>(probe: () => Promise<T | undefined>, label: string, timeoutMs = 20_000): Promise<T> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        const value = await probe()
        if (value !== undefined) return value
        await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error(`Timed out: ${label}`)
}

function exited(child: ChildProcess): boolean {
    return child.exitCode !== null || child.signalCode !== null
}

async function stop(child: ChildProcess | undefined): Promise<void> {
    if (!child || exited(child)) return
    child.kill('SIGTERM')
    try {
        await until(async () => exited(child) ? true : undefined, `PID ${child.pid} shutdown`, 5_000)
    } catch {
        child.kill('SIGKILL')
    }
}

/** Every process carries the run marker so the globalSetup sweep reaps leaks. */
function testEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return { ...process.env, [TEST_OWNED_MARKER_KEY]: process.env.HAPI_HOME, ...overrides }
}

/** Long-lived stand-in for a CLI process; its own group so tree kills stay local. */
function spawnIdleChild(): ChildProcess {
    const child = spawn(process.env.HAPI_BUN_EXEC!, ['--eval', 'setInterval(() => {}, 1000)'], {
        env: testEnv(), stdio: 'ignore', detached: true,
    })
    expect(child.pid).toBeDefined()
    return child
}

/** Isolated HAPI_HOME: own state file, lock and resume records; same temp hub. */
function startRunner(home: string): ChildProcess {
    return spawn(process.env.HAPI_BUN_EXEC!, ['--cwd', resolve('.'), resolve('src/index.ts'), 'runner', 'start-sync'], {
        env: testEnv({ HAPI_HOME: home, HAPI_DISABLE_VERSION_HANDOFF: '1' }), stdio: 'ignore',
    })
}

async function runnerReady(home: string, runner: ChildProcess): Promise<RunnerState> {
    return until(async () => {
        try {
            const state = JSON.parse(await readFile(join(home, 'runner.state.json'), 'utf8')) as Partial<RunnerState>
            return state.pid === runner.pid && state.httpPort ? state as RunnerState : undefined
        } catch {
            return undefined
        }
    }, 'isolated runner ready')
}

function control(state: RunnerState) {
    return async (path: string, body: unknown = {}): Promise<Record<string, unknown>> => {
        const response = await fetch(`http://127.0.0.1:${state.httpPort}${path}`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        })
        expect(response.status).toBe(200)
        return await response.json() as Record<string, unknown>
    }
}

async function readResumeRecords(home: string): Promise<ResumeRecord[]> {
    return JSON.parse(await readFile(join(home, 'runner.state.json.resume-processes.json'), 'utf8')) as ResumeRecord[]
}

describe.skipIf(process.platform === 'win32')('untracked runner webhook adoption', () => {
    it('adopts a webhook that carries the live process start marker, so the child is listed and stoppable', async () => {
        const sessionId = randomUUID()
        const home = await mkdtemp(join(tmpdir(), 'hapi-late-webhook-adopt-'))
        // A child of the previous runner generation: nothing on disk names it.
        const child = spawnIdleChild()
        const runner = startRunner(home)
        try {
            const post = control(await runnerReady(home, runner))
            const hostStartMarker = getProcessStartMarker(child.pid!)
            expect(hostStartMarker).not.toBeNull()
            await post('/session-started', { sessionId, metadata: { hostPid: child.pid, hostStartMarker, startedBy: 'runner' } })
            expect(exited(child)).toBe(false)
            expect(await post('/list')).toMatchObject({ children: [{ happySessionId: sessionId, pid: child.pid, startedBy: 'runner' }] })
            expect(await readResumeRecords(home)).toMatchObject([
                { pid: child.pid, requestedSessionId: sessionId, confirmedSessionId: sessionId, processStartMarker: hostStartMarker },
            ])
            expect(await post('/stop-session', { sessionId })).toMatchObject({ status: 'stopped' })
            await until(async () => exited(child) ? true : undefined, 'adopted child stopped')
        } finally {
            await stop(runner)
            await stop(child)
            await rm(home, { recursive: true, force: true })
        }
    }, 30_000)

    it('leaves a webhook alone that cannot prove the process generation, and never kills the PID', async () => {
        const sessionId = randomUUID()
        const home = await mkdtemp(join(tmpdir(), 'hapi-late-webhook-reused-pid-'))
        // Stands in for the process the OS handed the PID to after the
        // reporting CLI exited: the webhook names a generation that is gone,
        // or (older CLI) no generation at all.
        const bystander = spawnIdleChild()
        const runner = startRunner(home)
        try {
            const post = control(await runnerReady(home, runner))
            for (const metadata of [
                { hostPid: bystander.pid, hostStartMarker: 'Thu Jan  1 00:00:00 1970', startedBy: 'runner' },
                { hostPid: bystander.pid, startedBy: 'runner' },
            ]) {
                await post('/session-started', { sessionId, metadata })
                expect(await post('/list')).toMatchObject({ children: [] })
                expect(await readResumeRecords(home)).toEqual([])
                expect(await post('/stop-session', { sessionId })).toMatchObject({ status: 'unknown' })
                // Killing is escalated asynchronously; give a wrongful kill time to land.
                await new Promise(resolve => setTimeout(resolve, 300))
                expect(exited(bystander)).toBe(false)
            }
        } finally {
            await stop(runner)
            await stop(bystander)
            await rm(home, { recursive: true, force: true })
        }
    }, 30_000)
})
