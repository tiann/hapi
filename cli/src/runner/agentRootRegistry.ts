/**
 * Durable agent-process identity for archive probe (#2021 Approach).
 *
 * ACP / Cursor spawn the agent in its own POSIX process group (or Windows Job).
 * When the HAPI wrapper exits, a verified-exit tombstone alone must not prove
 * those agent processes stopped — tools can keep running under the detached
 * group. The CLI writes the agent root here at spawn; Runner probeSessionExit
 * refuses already_gone while the recorded root is still alive.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveHapiHomeDir } from '@/configuration'
import {
    getProcessStartMarker,
    isProcessAlive,
    retainedIdentityStillAlive,
    type RetainedProcessIdentity,
} from '@/utils/process'

export type AgentRootRecord = {
    hostPid: number
    pid: number
    startMarker: string | null
    bootId?: string | null
    tgid?: number | null
    pgid?: number | null
    sessionId?: string
}

function agentRootsDir(): string {
    return join(resolveHapiHomeDir(), 'locks', 'agent-roots')
}

function hostPath(hostPid: number): string {
    return join(agentRootsDir(), `host-${hostPid}.json`)
}

function parseRecord(raw: unknown): AgentRootRecord | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const rec = raw as Record<string, unknown>
    const hostPid = typeof rec.hostPid === 'number' ? rec.hostPid : null
    const pid = typeof rec.pid === 'number' ? rec.pid : null
    if (hostPid === null || hostPid <= 0 || pid === null || pid <= 0) return null
    return {
        hostPid,
        pid,
        startMarker: typeof rec.startMarker === 'string' ? rec.startMarker : null,
        bootId: typeof rec.bootId === 'string' ? rec.bootId : rec.bootId === null ? null : undefined,
        tgid: typeof rec.tgid === 'number' ? rec.tgid : rec.tgid === null ? null : undefined,
        pgid: typeof rec.pgid === 'number' ? rec.pgid : rec.pgid === null ? null : undefined,
        sessionId: typeof rec.sessionId === 'string' ? rec.sessionId : undefined,
    }
}

export function writeAgentRoot(record: AgentRootRecord): void {
    if (!Number.isSafeInteger(record.hostPid) || record.hostPid <= 0) return
    if (!Number.isSafeInteger(record.pid) || record.pid <= 0) return
    const dir = agentRootsDir()
    mkdirSync(dir, { recursive: true })
    const path = hostPath(record.hostPid)
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(record))
    renameSync(tmp, path)
}

export function clearAgentRoot(hostPid: number): void {
    if (!Number.isSafeInteger(hostPid) || hostPid <= 0) return
    try {
        unlinkSync(hostPath(hostPid))
    } catch {
        // Best effort.
    }
}

export function readAgentRootForHost(hostPid: number): AgentRootRecord | null {
    if (!Number.isSafeInteger(hostPid) || hostPid <= 0) return null
    const path = hostPath(hostPid)
    if (!existsSync(path)) return null
    try {
        return parseRecord(JSON.parse(readFileSync(path, 'utf8')))
    } catch {
        return null
    }
}

/** List every published agent-root record (small lock dir; crash recovery). */
export function listAgentRoots(): AgentRootRecord[] {
    const dir = agentRootsDir()
    if (!existsSync(dir)) return []
    const out: AgentRootRecord[] = []
    try {
        for (const name of readdirSync(dir)) {
            if (!name.startsWith('host-') || !name.endsWith('.json')) continue
            try {
                const record = parseRecord(JSON.parse(readFileSync(join(dir, name), 'utf8')))
                if (record) out.push(record)
            } catch {
                // Skip corrupt entries.
            }
        }
    } catch {
        return out
    }
    return out
}

/**
 * Find a still-alive agent root for this session. Prefers known host PIDs, then
 * scans publishes that stamped sessionId (maps may already be cleared after
 * wrapper exit).
 */
export function findLiveAgentRootForSession(
    sessionId: string,
    knownHostPids: Iterable<number> = [],
): AgentRootRecord | null {
    const seen = new Set<number>()
    for (const hostPid of knownHostPids) {
        if (!Number.isSafeInteger(hostPid) || hostPid <= 0 || seen.has(hostPid)) continue
        seen.add(hostPid)
        const root = readAgentRootForHost(hostPid)
        if (root && agentRootRecordStillAlive(root)) return root
        if (root && !agentRootRecordStillAlive(root)) clearAgentRoot(hostPid)
    }
    for (const root of listAgentRoots()) {
        if (seen.has(root.hostPid)) continue
        if (root.sessionId !== sessionId) continue
        if (agentRootRecordStillAlive(root)) return root
        clearAgentRoot(root.hostPid)
    }
    return null
}

export function agentRootRecordStillAlive(record: AgentRootRecord): boolean {
    const identity: RetainedProcessIdentity = {
        pid: record.pid,
        startMarker: record.startMarker,
        bootId: record.bootId ?? null,
        tgid: record.tgid ?? null,
        pgid: record.pgid ?? null,
    }
    // Prefer generation-bound identity when we have a start marker; fall back
    // to bare liveness when the platform could not capture one at spawn.
    if (record.startMarker) {
        return retainedIdentityStillAlive(identity)
    }
    return isProcessAlive(record.pid)
}

/** Publish spawn identity for the current HAPI host process. */
export function publishAgentRootFromIdentity(
    identity: RetainedProcessIdentity,
    extras?: { sessionId?: string },
): void {
    writeAgentRoot({
        hostPid: process.pid,
        pid: identity.pid,
        startMarker: identity.startMarker ?? getProcessStartMarker(identity.pid),
        bootId: identity.bootId,
        tgid: identity.tgid,
        pgid: identity.pgid,
        sessionId: extras?.sessionId,
    })
}

export function clearAgentRootForCurrentHost(): void {
    clearAgentRoot(process.pid)
}
