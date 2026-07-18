import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
    cleanupIntegrationFixtures,
    hasExpectedTermKillReceipt,
    isCleanIntegrationFixtureCleanup
} from './integrationFixtureCleanup'

const temporaryDirectories: string[] = []

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function ledger(lines: unknown[]): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'hapi-runner-cleanup-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'ledger.jsonl')
    await writeFile(path, `${lines.map((line) => typeof line === 'string' ? line : JSON.stringify(line)).join('\n')}\n`)
    return path
}

function start(pid: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        event: 'process-started',
        pid,
        at: 1,
        launchNonce: `launch-${pid}`,
        runnerInstanceId: `runner-${pid}`,
        birthToken: `birth-${pid}`,
        pgid: pid,
        executableRealpath: '/opt/hapi/bin/bun',
        ...overrides
    }
}

describe('integration fixture cleanup', () => {
    it('requires one exact probe to receive both TERM and KILL receipts', () => {
        const result = {
            startedPids: [501],
            invalidEntries: [],
            cleanupErrors: [],
            termSignaled: [501],
            killSignaled: [501],
            mismatchedLivePids: [],
            exactLivePids: []
        }

        expect(hasExpectedTermKillReceipt(result, 501)).toBe(true)
        expect(hasExpectedTermKillReceipt({ ...result, killSignaled: [] }, 501)).toBe(false)
        expect(hasExpectedTermKillReceipt(result, 502)).toBe(false)
    })

    it('rejects an unreadable ledger instead of treating it as empty', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'hapi-runner-cleanup-missing-'))
        temporaryDirectories.push(directory)

        await expect(cleanupIntegrationFixtures({
            ledgerFile: join(directory, 'missing-ledger.jsonl')
        })).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('rejects an unexpected event in the dedicated process ledger', async () => {
        const path = await ledger([{ event: 'session-created', pid: 123 }])

        const result = await cleanupIntegrationFixtures({ ledgerFile: path })

        expect(result.invalidEntries).toEqual([
            expect.objectContaining({ line: 1, pid: 123, reason: 'unexpected ledger event' })
        ])
        expect(isCleanIntegrationFixtureCleanup(result)).toBe(false)
    })

    it('records an uncertain liveness probe instead of treating the fixture as gone', async () => {
        const path = await ledger([start(401)])
        const denied = Object.assign(new Error('denied'), { code: 'EPERM' })

        const result = await cleanupIntegrationFixtures({
            ledgerFile: path,
            isAlive: () => { throw denied }
        })

        expect(result.cleanupErrors).toEqual([
            expect.objectContaining({ pid: 401, operation: 'liveness', code: 'EPERM' })
        ])
        expect(isCleanIntegrationFixtureCleanup(result)).toBe(false)
    })

    it('terminates each exact live binding and ignores already exited fixtures', async () => {
        const path = await ledger([start(101), start(102)])
        const live = new Set([101])
        const signals: Array<[number, NodeJS.Signals]> = []

        const result = await cleanupIntegrationFixtures({
            ledgerFile: path,
            isAlive: (pid) => live.has(pid),
            verifyExact: async (binding) => live.has(binding.pid) ? 'exact' : 'gone',
            sendSignal: (pid, signal) => {
                signals.push([pid, signal])
                live.delete(pid)
            },
            sleep: async () => undefined,
            termTimeoutMs: 0,
            killTimeoutMs: 0
        })

        expect(signals).toEqual([[101, 'SIGTERM']])
        expect(result).toEqual(expect.objectContaining({
            startedPids: [101, 102],
            termSignaled: [101],
            killSignaled: [],
            invalidEntries: [],
            mismatchedLivePids: [],
            exactLivePids: []
        }))
    })

    it('revalidates exact identity before escalating a TERM-resistant fixture to KILL', async () => {
        const path = await ledger([start(201)])
        let live = true
        const operations: string[] = []

        const result = await cleanupIntegrationFixtures({
            ledgerFile: path,
            isAlive: () => live,
            verifyExact: async (binding) => {
                operations.push(`verify:${binding.pid}`)
                return 'exact'
            },
            sendSignal: (pid, signal) => {
                operations.push(`signal:${pid}:${signal}`)
                if (signal === 'SIGKILL') live = false
            },
            sleep: async () => undefined,
            termTimeoutMs: 0,
            killTimeoutMs: 0
        })

        expect(operations).toEqual([
            'verify:201',
            'signal:201:SIGTERM',
            'verify:201',
            'signal:201:SIGKILL'
        ])
        expect(result.termSignaled).toEqual([201])
        expect(result.killSignaled).toEqual([201])
        expect(result.exactLivePids).toEqual([])
    })

    it('refuses malformed, conflicting, or mismatched bindings without signalling them', async () => {
        const path = await ledger([
            '{not-json',
            start(301, { birthToken: '' }),
            start(302),
            start(302, { birthToken: 'different-birth' }),
            start(303)
        ])
        const verified: number[] = []
        const signalled: number[] = []

        const result = await cleanupIntegrationFixtures({
            ledgerFile: path,
            isAlive: () => true,
            verifyExact: async (binding) => {
                verified.push(binding.pid)
                throw new Error('kernel identity mismatch')
            },
            sendSignal: (pid) => { signalled.push(pid) },
            sleep: async () => undefined,
            termTimeoutMs: 0,
            killTimeoutMs: 0
        })

        expect(verified).toEqual([303])
        expect(signalled).toEqual([])
        expect(result.startedPids).toEqual([303])
        expect(result.invalidEntries.map((entry) => entry.line)).toEqual([1, 2, 4])
        expect(result.mismatchedLivePids).toEqual([303])
        expect(result.termSignaled).toEqual([])
        expect(result.killSignaled).toEqual([])
    })
})
