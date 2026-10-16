import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { configuration, getProcessStartMarker, isProcessAlive } = vi.hoisted(() => ({
    configuration: { happyHomeDir: '' },
    getProcessStartMarker: vi.fn<(pid: number) => string | null>(),
    isProcessAlive: vi.fn<(pid: number) => boolean>()
}))

vi.mock('@/configuration', () => ({ configuration }))
vi.mock('@/utils/process', () => ({ getProcessStartMarker, isProcessAlive }))
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn() } }))

import { acquireSessionSlot, parseMaxLiveSessions, withSessionCapacity } from './sessionCapacity'

describe('parseMaxLiveSessions', () => {
    it('defaults to 20 and accepts an explicit limit or zero to disable it', () => {
        expect(parseMaxLiveSessions(undefined)).toBe(20)
        expect(parseMaxLiveSessions('7')).toBe(7)
        expect(parseMaxLiveSessions('0')).toBe(0)
    })

    it.each(['', '-1', '1.5', '20x', '1e2', 'Infinity', 'NaN', ' 20', '20 ', '9007199254740992'])(
        'rejects invalid configuration %j', value => {
            expect(() => parseMaxLiveSessions(value)).toThrow('HAPI_MAX_LIVE_SESSIONS')
        }
    )
})

describe('session capacity leases', () => {
    let home: string
    const releases: Array<() => void> = []

    beforeEach(async () => {
        home = await mkdtemp(join(tmpdir(), 'hapi-session-capacity-'))
        configuration.happyHomeDir = home
        vi.stubEnv('HAPI_MAX_LIVE_SESSIONS', '2')
        getProcessStartMarker.mockReset()
        getProcessStartMarker.mockImplementation(pid => `generation-${pid}`)
        isProcessAlive.mockReset()
        isProcessAlive.mockReturnValue(true)
    })

    afterEach(async () => {
        releases.splice(0).forEach(release => release())
        vi.unstubAllEnvs()
        await rm(home, { recursive: true, force: true })
    })

    async function acquire(): Promise<() => void> {
        const release = await acquireSessionSlot()
        releases.push(release)
        return release
    }

    async function leaseNames(): Promise<string[]> {
        return (await readdir(join(home, 'live-sessions'))).filter(name => name.endsWith('.json'))
    }

    async function seedLease(name: string, data: unknown): Promise<void> {
        const directory = join(home, 'live-sessions')
        await mkdir(directory, { recursive: true })
        await writeFile(join(directory, `${name}.json`), JSON.stringify(data))
    }

    it('admits 20 roots by default and rejects the twenty-first', async () => {
        vi.stubEnv('HAPI_MAX_LIVE_SESSIONS', undefined)
        for (let index = 0; index < 20; index++) await acquire()
        await expect(acquire()).rejects.toThrow('Live session limit reached (20/20)')
        expect(await leaseNames()).toHaveLength(20)
    })

    it('admits exactly the configured number when acquisitions race', async () => {
        vi.stubEnv('HAPI_MAX_LIVE_SESSIONS', '3')
        // Keep real filesystem locking: mocked or serial admissions would miss oversubscription.
        const results = await Promise.allSettled(Array.from({ length: 8 }, () => acquire()))
        expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(3)
        const rejected = results.filter(result => result.status === 'rejected')
        expect(rejected).toHaveLength(5)
        for (const result of rejected) {
            expect(result.reason).toBeInstanceOf(Error)
            expect(result.reason.message).toContain('Live session limit reached (3/3)')
        }
        expect(await leaseNames()).toHaveLength(3)
    })

    it('enforces one shared limit across real competing CLI processes', async () => {
        const modulePath = fileURLToPath(new URL('./sessionCapacity.ts', import.meta.url))
        const script = `
            const { acquireSessionSlot } = await import(${JSON.stringify(modulePath)});
            try {
                const release = await acquireSessionSlot();
                console.log('CAPACITY_RESULT acquired');
                await new Promise(resolve => process.stdin.once('data', resolve));
                release();
            } catch (error) {
                console.log('CAPACITY_RESULT ' + (error.message.includes('Live session limit reached') ? 'rejected' : 'error ' + error.message));
            }
            process.exit(0);
        `
        const workers = Array.from({ length: 6 }, () => {
            const child = spawn(process.env.HAPI_BUN_EXEC ?? 'bun', ['--eval', script], {
                cwd: fileURLToPath(new URL('../..', import.meta.url)),
                env: {
                    PATH: process.env.PATH,
                    HOME: process.env.HOME,
                    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
                    HAPI_HOME: home,
                    HAPI_MAX_LIVE_SESSIONS: '2'
                },
                stdio: ['pipe', 'pipe', 'pipe']
            })
            const exited = new Promise<void>(resolve => child.once('close', () => resolve()))
            const result = new Promise<string>((resolve, reject) => {
                let output = ''
                let errors = ''
                child.stdout.on('data', data => {
                    output += data.toString()
                    const match = output.match(/CAPACITY_RESULT ([^\r\n]+)[\r\n]/)
                    if (match) resolve(match[1])
                })
                child.stderr.on('data', data => { errors += data.toString() })
                child.once('error', reject)
                child.once('close', () => reject(new Error(`Capacity worker exited before reporting: ${errors}`)))
            })
            return { child, exited, result }
        })
        let timeout: ReturnType<typeof setTimeout> | undefined
        try {
            const results = await Promise.race([
                Promise.all(workers.map(worker => worker.result)),
                new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Capacity workers timed out')), 15_000) })
            ])
            expect(results.filter(result => result === 'acquired')).toHaveLength(2)
            expect(results.filter(result => result === 'rejected')).toHaveLength(4)
            // Successful owners are held alive until every concurrent request has completed.
            expect(await leaseNames()).toHaveLength(2)
        } finally {
            clearTimeout(timeout)
            for (const { child } of workers) {
                if (child.exitCode === null && child.signalCode === null) child.kill()
            }
            await Promise.all(workers.map(worker => worker.exited))
        }
    }, 20_000)

    it('counts multiple roots in the same process independently', async () => {
        await acquire()
        await acquire()
        const leases = await Promise.all((await leaseNames()).map(async name =>
            JSON.parse(await readFile(join(home, 'live-sessions', name), 'utf8'))
        ))
        expect(leases).toHaveLength(2)
        expect(leases.every(lease => lease.pid === process.pid)).toBe(true)
        await expect(acquire()).rejects.toThrow('Live session limit reached (2/2)')
    })

    it('releases immediately and idempotently so a close can be followed by a new root', async () => {
        vi.stubEnv('HAPI_MAX_LIVE_SESSIONS', '1')
        const release = await acquire()
        release()
        release()
        await acquire()
        expect(await leaseNames()).toHaveLength(1)
    })

    it('reclaims a crashed owner and a reused PID before admission', async () => {
        vi.stubEnv('HAPI_MAX_LIVE_SESSIONS', '1')
        await seedLease('crashed', { pid: 123, marker: 'old' })
        await seedLease('reused', { pid: 456, marker: 'old' })
        isProcessAlive.mockImplementation(pid => pid !== 123)
        const release = await acquire()
        expect(await leaseNames()).toHaveLength(1)
        release()
        expect(await leaseNames()).toEqual([])
    })

    it('retains a live owner whose process generation cannot be probed', async () => {
        vi.stubEnv('HAPI_MAX_LIVE_SESSIONS', '1')
        await seedLease('uncertain', { pid: 123, marker: 'original' })
        getProcessStartMarker.mockImplementation(pid => pid === 123 ? null : `generation-${pid}`)
        await expect(acquire()).rejects.toThrow('Live session limit reached (1/1)')
        expect(await leaseNames()).toEqual(['uncertain.json'])
    })

    it('retains a verified live lease from a different process', async () => {
        vi.stubEnv('HAPI_MAX_LIVE_SESSIONS', '1')
        await seedLease('live', { pid: 123, marker: 'generation-123' })
        await expect(acquire()).rejects.toThrow('Live session limit reached (1/1)')
    })

    it('fails closed on malformed JSON without deleting the evidence', async () => {
        await seedLease('broken', {})
        const path = join(home, 'live-sessions', 'broken.json')
        await writeFile(path, '{incomplete')
        await expect(acquire()).rejects.toThrow('Cannot verify live session lease')
        expect(await readFile(path, 'utf8')).toBe('{incomplete')
    })

    it.each([
        { pid: 0, marker: 'original' },
        { pid: 123, marker: '' },
        { pid: '123', marker: 'original' },
        { marker: 'original' }
    ])('fails closed on an invalid lease record %j', async lease => {
        await seedLease('invalid', lease)
        await expect(acquire()).rejects.toThrow('Cannot verify live session lease')
        expect(await leaseNames()).toEqual(['invalid.json'])
    })

    it('does not create a lease if the acquiring process generation is unavailable', async () => {
        getProcessStartMarker.mockReturnValue(null)
        await expect(acquire()).rejects.toThrow('Cannot verify this process generation')
        expect(await leaseNames()).toEqual([])
    })

    it('tracks roots even when zero disables the limit', async () => {
        vi.stubEnv('HAPI_MAX_LIVE_SESSIONS', '0')
        for (let index = 0; index < 4; index++) await acquire()
        expect(await leaseNames()).toHaveLength(4)
        // Turning the limit back on must account for roots admitted while unlimited.
        vi.stubEnv('HAPI_MAX_LIVE_SESSIONS', '2')
        await expect(acquire()).rejects.toThrow('Live session limit reached (4/2)')
    })

    it('releases a failed bootstrap and preserves its error', async () => {
        vi.stubEnv('HAPI_MAX_LIVE_SESSIONS', '1')
        const failure = new Error('hub unavailable')
        const bootstrap = withSessionCapacity(async () => { throw failure })
        await expect(bootstrap(undefined)).rejects.toBe(failure)
        expect(await leaseNames()).toEqual([])
        await acquire()
    })

    it('holds successful bootstrap capacity until its close callback runs', async () => {
        vi.stubEnv('HAPI_MAX_LIVE_SESSIONS', '1')
        const bootstrap = withSessionCapacity(async (_options: undefined, close: () => void) => ({ close }))
        const root = await bootstrap(undefined)
        releases.push(root.close)
        await expect(bootstrap(undefined)).rejects.toThrow('Live session limit reached (1/1)')
        root.close()
        const replacement = await bootstrap(undefined)
        releases.push(replacement.close)
        expect(await leaseNames()).toHaveLength(1)
    })

    it('rejects before invoking bootstrap when capacity is exhausted', async () => {
        vi.stubEnv('HAPI_MAX_LIVE_SESSIONS', '1')
        await acquire()
        const createRemoteSession = vi.fn(async () => 'unexpected')
        await expect(withSessionCapacity(createRemoteSession)(undefined)).rejects.toThrow('Live session limit reached')
        expect(createRemoteSession).not.toHaveBeenCalled()
    })
})
