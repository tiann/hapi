import { describe, expect, test, afterEach } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    acquireAgentCliSpawnLease,
    acquireAgentCliSpawnLeaseSync,
    getAgentCliSpawnLockTarget,
    releaseAgentCliSpawnLeaseFromAcpRegisterSync,
    releaseAgentCliSpawnLeaseSync,
    tryAcquireAgentCliSpawnLeaseSync,
    _resetAgentCliSpawnLeaseForTests,
} from './agentCliSpawnLease'

describe('agentCliSpawnLease', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hapi-agent-cli-spawn-lease-'))

    afterEach(() => {
        _resetAgentCliSpawnLeaseForTests(dir)
    })

    test('exclusive lease blocks a second non-blocking acquirer', () => {
        expect(tryAcquireAgentCliSpawnLeaseSync(dir)).toBe(true)
        expect(tryAcquireAgentCliSpawnLeaseSync(dir)).toBe(false)
        releaseAgentCliSpawnLeaseSync()
        expect(tryAcquireAgentCliSpawnLeaseSync(dir)).toBe(true)
        releaseAgentCliSpawnLeaseSync()
    })

    test('ACP register depth shares one lease until the last unregister', () => {
        acquireAgentCliSpawnLeaseSync(dir)
        acquireAgentCliSpawnLeaseSync(dir)
        expect(tryAcquireAgentCliSpawnLeaseSync(dir)).toBe(false)
        releaseAgentCliSpawnLeaseFromAcpRegisterSync()
        expect(tryAcquireAgentCliSpawnLeaseSync(dir)).toBe(false)
        releaseAgentCliSpawnLeaseFromAcpRegisterSync()
        expect(tryAcquireAgentCliSpawnLeaseSync(dir)).toBe(true)
        releaseAgentCliSpawnLeaseSync()
    })

    test('ACP blocking acquire succeeds after probe releases the lease', () => {
        expect(tryAcquireAgentCliSpawnLeaseSync(dir)).toBe(true)
        expect(tryAcquireAgentCliSpawnLeaseSync(dir)).toBe(false)
        releaseAgentCliSpawnLeaseSync()
        acquireAgentCliSpawnLeaseSync(dir)
        releaseAgentCliSpawnLeaseFromAcpRegisterSync()
    })

    test('async blocking acquire yields while same-process probe holds lease', async () => {
        expect(tryAcquireAgentCliSpawnLeaseSync(dir)).toBe(true)
        const acquirePromise = acquireAgentCliSpawnLease(dir)
        let probeReleased = false
        setTimeout(() => {
            releaseAgentCliSpawnLeaseSync()
            probeReleased = true
        }, 50)
        await acquirePromise
        expect(probeReleased).toBe(true)
        releaseAgentCliSpawnLeaseFromAcpRegisterSync()
    })

    test('anchors spawn lease beside the agent-acp-active marker directory', () => {
        const target = getAgentCliSpawnLockTarget(dir)
        expect(target.endsWith(join('locks', 'agent-cli.spawn'))).toBe(true)
        acquireAgentCliSpawnLeaseSync(dir)
        expect(existsSync(join(dir, 'locks', 'agent-acp-active'))).toBe(false)
        expect(existsSync(target)).toBe(true)
        releaseAgentCliSpawnLeaseFromAcpRegisterSync()
    })

    test('reclaims a stale spawn lease left by a crashed holder', () => {
        const target = getAgentCliSpawnLockTarget(dir)
        const lockDir = spawnLockfilePath(target)
        mkdirSync(lockDir)
        const past = new Date(Date.now() - 300_000)
        utimesSync(lockDir, past, past)

        expect(tryAcquireAgentCliSpawnLeaseSync(dir)).toBe(true)
        releaseAgentCliSpawnLeaseSync()
        expect(existsSync(lockDir)).toBe(false)
    })
})

function spawnLockfilePath(lockTarget: string): string {
    return `${lockTarget}.hapi.lock`
}
