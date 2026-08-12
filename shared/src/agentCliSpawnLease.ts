/**
 * Cross-process exclusive lease for Cursor `agent` child processes.
 * ACP transport and `agent --list-models` probes must not overlap — Cursor
 * SIGTERMs the other child (exit 143). Uses proper-lockfile beside the
 * agent-acp-active marker dir so acquisition is atomic (no check-then-act).
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import lockfile from 'proper-lockfile'

const SPAWN_LOCK_STALE_MS = 120_000
const SPAWN_LOCK_UPDATE_MS = 30_000
const SPAWN_LOCK_RETRY_INTERVAL_MS = 100
const SPAWN_LOCK_MAX_ATTEMPTS = 300

/** Cross-process lease release fn when this process holds the spawn lease. */
let leaseRelease: (() => void) | null = null
/** Nested ACP registerActiveAcpTransport calls sharing one lease. */
let acpRegisterLeaseDepth = 0

function sleepMsSync(ms: number): void {
    const bun = (globalThis as { Bun?: { sleepSync?: (duration: number) => void } }).Bun
    if (bun?.sleepSync) {
        bun.sleepSync(ms)
        return
    }
    const end = Date.now() + ms
    while (Date.now() < end) {
        // Node vitest fallback when Bun.sleepSync is unavailable.
    }
}

function spawnLockfilePath(lockTarget: string): string {
    return `${lockTarget}.hapi.lock`
}

function lockOptions(lockTarget: string): {
    realpath: boolean
    lockfilePath: string
    stale: number
    update: number
    retries: number
} {
    return {
        realpath: false,
        lockfilePath: spawnLockfilePath(lockTarget),
        stale: SPAWN_LOCK_STALE_MS,
        update: SPAWN_LOCK_UPDATE_MS,
        retries: 0,
    }
}

/** Lease anchor file colocated with the agent-acp-active marker directory. */
export function getAgentCliSpawnLockTarget(hapiHome: string): string {
    const locksDir = join(hapiHome, 'locks')
    mkdirSync(locksDir, { recursive: true })
    const target = join(locksDir, 'agent-cli.spawn')
    if (!existsSync(target)) {
        writeFileSync(target, '', { flag: 'a' })
    }
    return target
}

function claimSpawnLeaseSync(hapiHome: string): boolean {
    if (leaseRelease !== null) {
        return false
    }
    const lockTarget = getAgentCliSpawnLockTarget(hapiHome)
    try {
        leaseRelease = lockfile.lockSync(lockTarget, lockOptions(lockTarget))
        return true
    } catch {
        return false
    }
}

/**
 * Non-blocking exclusive lease for model-list probes. Returns false when
 * another holder (ACP or probe) already owns the spawn lease.
 */
export function tryAcquireAgentCliSpawnLeaseSync(hapiHome: string): boolean {
    if (leaseRelease !== null || acpRegisterLeaseDepth > 0) {
        return false
    }
    return claimSpawnLeaseSync(hapiHome)
}

function sleepMs(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Blocking exclusive lease for ACP transport startup (sync — tests only). */
export function acquireAgentCliSpawnLeaseSync(hapiHome: string): void {
    if (acpRegisterLeaseDepth > 0) {
        acpRegisterLeaseDepth += 1
        return
    }

    for (let attempt = 0; attempt < SPAWN_LOCK_MAX_ATTEMPTS; attempt++) {
        if (claimSpawnLeaseSync(hapiHome)) {
            acpRegisterLeaseDepth = 1
            return
        }
        sleepMsSync(SPAWN_LOCK_RETRY_INTERVAL_MS)
    }

    throw new Error('agent CLI spawn lease held by another process')
}

/** Blocking exclusive lease for ACP transport startup (yields event loop between retries). */
export async function acquireAgentCliSpawnLease(hapiHome: string): Promise<void> {
    if (acpRegisterLeaseDepth > 0) {
        acpRegisterLeaseDepth += 1
        return
    }

    for (let attempt = 0; attempt < SPAWN_LOCK_MAX_ATTEMPTS; attempt++) {
        if (claimSpawnLeaseSync(hapiHome)) {
            acpRegisterLeaseDepth = 1
            return
        }
        await sleepMs(SPAWN_LOCK_RETRY_INTERVAL_MS)
    }

    throw new Error('agent CLI spawn lease held by another process')
}

/** Release after a list-models probe child exits. */
export function releaseAgentCliSpawnLeaseSync(): void {
    if (acpRegisterLeaseDepth > 0 || leaseRelease === null) {
        return
    }
    leaseRelease()
    leaseRelease = null
}

/** Release after the last ACP transport unregisters in this process. */
export function releaseAgentCliSpawnLeaseFromAcpRegisterSync(): void {
    if (acpRegisterLeaseDepth <= 0) {
        return
    }
    acpRegisterLeaseDepth -= 1
    if (acpRegisterLeaseDepth > 0 || leaseRelease === null) {
        return
    }
    leaseRelease()
    leaseRelease = null
}

/** @internal test-only */
export function _resetAgentCliSpawnLeaseForTests(hapiHome?: string): void {
    acpRegisterLeaseDepth = 0
    if (leaseRelease) {
        leaseRelease()
        leaseRelease = null
    }
    if (!hapiHome) {
        return
    }
    const lockTarget = getAgentCliSpawnLockTarget(hapiHome)
    try {
        lockfile.unlockSync(lockTarget, {
            realpath: false,
            lockfilePath: spawnLockfilePath(lockTarget),
        })
    } catch {
        // Best effort — lock may not exist.
    }
}
