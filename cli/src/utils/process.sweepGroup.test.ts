import crossSpawn from 'cross-spawn'
import { spawn, type ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getProcessStartMarker, sweepProcessGroup } from './process'

const posix = process.platform !== 'win32'

function groupAlive(pgid: number): boolean {
    try {
        process.kill(-pgid, 0)
        return true
    } catch {
        return false
    }
}

async function waitFor(check: () => boolean, timeoutMs = 3_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!check()) {
        if (Date.now() > deadline) throw new Error('timed out')
        await new Promise(r => setTimeout(r, 20))
    }
}

describe.skipIf(!posix)('sweepProcessGroup (POSIX)', () => {
    const children: ChildProcess[] = []

    afterEach(() => {
        for (const child of children.splice(0)) {
            if (child.pid) {
                try { process.kill(-child.pid, 'SIGKILL') } catch { /* gone */ }
            }
        }
    })

    function spawnGroup(script: string): number {
        const child = spawn('sh', ['-c', script], { detached: true, stdio: 'ignore' })
        children.push(child)
        child.unref()
        return child.pid!
    }

    it('returns true immediately for an empty group', async () => {
        const pgid = spawnGroup('exit 0')
        await waitFor(() => !groupAlive(pgid))
        await expect(sweepProcessGroup(pgid)).resolves.toBe(true)
    })

    it('reaps a straggler left after the group leader exits', async () => {
        const pgid = spawnGroup('sleep 30 & kill -TERM $$')
        await waitFor(() => groupAlive(pgid))
        await new Promise(r => setTimeout(r, 100))
        expect(groupAlive(pgid)).toBe(true)
        await expect(sweepProcessGroup(pgid)).resolves.toBe(true)
        expect(groupAlive(pgid)).toBe(false)
    })

    it('escalates to SIGKILL when the group ignores SIGTERM', async () => {
        const pgid = spawnGroup("trap '' TERM; sleep 30 & wait")
        await waitFor(() => groupAlive(pgid))
        await new Promise(r => setTimeout(r, 100))
        const marker = getProcessStartMarker(pgid)!
        const started = Date.now()
        await expect(sweepProcessGroup(pgid, { graceMs: 200, expectedStartMarker: marker })).resolves.toBe(true)
        expect(Date.now() - started).toBeGreaterThanOrEqual(150)
        expect(groupAlive(pgid)).toBe(false)
    })

    it('refuses to signal its own process', async () => {
        await expect(sweepProcessGroup(process.pid)).resolves.toBe(false)
    })

    it('rejects invalid pids', async () => {
        await expect(sweepProcessGroup(0)).resolves.toBe(false)
        await expect(sweepProcessGroup(1)).resolves.toBe(false)
        await expect(sweepProcessGroup(Number.NaN)).resolves.toBe(false)
    })

    it('does not signal after the deadline has passed', async () => {
        const pgid = spawnGroup('sleep 30')
        await waitFor(() => groupAlive(pgid))
        await expect(sweepProcessGroup(pgid, {
            deadlineMs: 0, expectedStartMarker: getProcessStartMarker(pgid)!,
        })).resolves.toBe(false)
        expect(groupAlive(pgid)).toBe(true)
    })

    it('fails closed without signalling a live leader of unverified generation', async () => {
        const pgid = spawnGroup('sleep 30')
        await waitFor(() => groupAlive(pgid))
        await expect(sweepProcessGroup(pgid, { graceMs: 100 })).resolves.toBe(false)
        expect(groupAlive(pgid)).toBe(true)
    })

    it('treats a leader with a different start marker as a recycled PID and leaves its group alone', async () => {
        const pgid = spawnGroup('sleep 30')
        await waitFor(() => groupAlive(pgid))
        await expect(sweepProcessGroup(pgid, { graceMs: 100, expectedStartMarker: 'older generation' }))
            .resolves.toBe(true)
        expect(groupAlive(pgid)).toBe(true)
    })

    it.each([true, false])('rechecks a missing leader marker before escalation (leader alive: %s)', async alive => {
        const pgid = 4_000_001
        let probes = 0
        let groupGone = false
        const ps = vi.spyOn(crossSpawn, 'sync').mockImplementation((_command, args) => {
            const markerQuery = Array.isArray(args) && args.includes('lstart=')
            const output = markerQuery ? (++probes === 1 ? 'generation' : '') : '99'
            return { status: 0, stdout: Buffer.from(output) } as ReturnType<typeof crossSpawn.sync>
        })
        const kill = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
            if (pid === -pgid && signal === 'SIGKILL') groupGone = true
            if ((pid === pgid && probes >= 2 && !alive) || (pid === -pgid && signal === 0 && groupGone)) {
                throw Object.assign(new Error('gone'), { code: 'ESRCH' })
            }
            return true
        }) as typeof process.kill)
        try {
            await expect(sweepProcessGroup(pgid, { graceMs: 0, expectedStartMarker: 'generation' })).resolves.toBe(!alive)
            expect(groupGone).toBe(!alive)
        } finally {
            kill.mockRestore()
            ps.mockRestore()
        }
    })

    it('stops without SIGKILL once the dead leader PID is recycled mid-sweep', async () => {
        const pgid = 4_000_001
        let recycled = false
        const signals: Array<[number, string | number | undefined]> = []
        const kill = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
            signals.push([pid, signal])
            if (pid === -pgid) {
                if (signal === 'SIGTERM') recycled = true
                return true
            }
            if (pid === pgid && signal === 0) {
                if (recycled) return true
                throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
            }
            throw new Error(`unexpected kill(${pid}, ${String(signal)})`)
        }) as typeof process.kill)
        try {
            await expect(sweepProcessGroup(pgid, { graceMs: 2_000 })).resolves.toBe(true)
        } finally {
            kill.mockRestore()
        }
        expect(signals).toContainEqual([-pgid, 'SIGTERM'])
        expect(signals).not.toContainEqual([-pgid, 'SIGKILL'])
    })
})

describe('sweepProcessGroup (win32)', () => {
    it('is a no-op that reports success', async () => {
        const original = Object.getOwnPropertyDescriptor(process, 'platform')!
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
        try {
            await expect(sweepProcessGroup(123456)).resolves.toBe(true)
        } finally {
            Object.defineProperty(process, 'platform', original)
        }
    })
})
