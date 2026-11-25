/**
 * Durable agent-process containment for archive probe (#2021 Approach).
 *
 * ACP / Cursor spawn the agent in its own POSIX process group (or Windows Job).
 * Wrapper exit tombstones are not containment proof — tools can keep running
 * under a detached group after the group leader dies. Persist the agent root
 * against the HAPI session id + wrapper hostPid; Runner probe/stop refuse
 * already_gone until classifyAgentOwnedProcessGroup reports empty/foreign
 * (or Windows root identity is gone).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveHapiHomeDir } from '@/configuration'
import { HAPI_SESSION_ID_ENV } from '@/agent/hapiSessionEnv'
import {
    classifyAgentOwnedProcessGroup,
    getProcessStartMarker,
    isWindows,
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
    /** HAPI hub session UUID — never the ACP agent session id. */
    sessionId?: string
}

function agentRootsDir(): string {
    return join(resolveHapiHomeDir(), 'locks', 'agent-roots')
}

function hostPath(hostPid: number): string {
    return join(agentRootsDir(), `host-${hostPid}.json`)
}

function sessionPath(sessionId: string): string {
    // Sanitize path segment — hub ids are UUIDs; reject anything odd.
    const safe = sessionId.replace(/[^a-zA-Z0-9._-]/g, '')
    return join(agentRootsDir(), `session-${safe}.json`)
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

function writeAtomic(path: string, record: AgentRootRecord): void {
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(record))
    renameSync(tmp, path)
}

export function writeAgentRoot(record: AgentRootRecord): void {
    if (!Number.isSafeInteger(record.hostPid) || record.hostPid <= 0) return
    if (!Number.isSafeInteger(record.pid) || record.pid <= 0) return
    const dir = agentRootsDir()
    mkdirSync(dir, { recursive: true })
    writeAtomic(hostPath(record.hostPid), record)
    if (record.sessionId && record.sessionId.length > 0) {
        writeAtomic(sessionPath(record.sessionId), record)
    }
}

export function clearAgentRoot(hostPid: number): void {
    if (!Number.isSafeInteger(hostPid) || hostPid <= 0) return
    const existing = readAgentRootForHost(hostPid)
    try {
        unlinkSync(hostPath(hostPid))
    } catch {
        // Best effort.
    }
    if (existing?.sessionId) {
        try {
            unlinkSync(sessionPath(existing.sessionId))
        } catch {
            // Best effort.
        }
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

export function readAgentRootForSession(sessionId: string): AgentRootRecord | null {
    if (!sessionId || sessionId.startsWith('PID-')) return null
    const path = sessionPath(sessionId)
    if (!existsSync(path)) return null
    try {
        return parseRecord(JSON.parse(readFileSync(path, 'utf8')))
    } catch {
        return null
    }
}

/** List every published host-* agent-root record (small lock dir; crash recovery). */
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
 * True while agent containment may still have members. Fail closed on
 * unknown / unprobeable groups — never treat a dead leader PID alone as
 * group exit (#2021 Approach).
 */
export function agentRootContainmentActive(record: AgentRootRecord): boolean {
    const identity: RetainedProcessIdentity = {
        pid: record.pid,
        startMarker: record.startMarker,
        bootId: record.bootId ?? null,
        tgid: record.tgid ?? null,
        pgid: record.pgid ?? null,
    }
    if (!isWindows() && typeof record.pgid === 'number' && record.pgid > 0) {
        const state = classifyAgentOwnedProcessGroup(identity)
        // empty/foreign ⇒ containment ended; ours/unknown ⇒ still blocking
        return state === 'ours' || state === 'unknown'
    }
    // Windows / no pgid: generation-bound root identity (match or unknown).
    return retainedIdentityStillAlive(identity)
}

/** @deprecated Use agentRootContainmentActive — name kept for call-site churn. */
export function agentRootRecordStillAlive(record: AgentRootRecord): boolean {
    return agentRootContainmentActive(record)
}

/**
 * Find active containment for this HAPI session. Prefers known host PIDs, then
 * the session-* index, then a host-* scan by stamped sessionId.
 */
export function findLiveAgentRootForSession(
    sessionId: string,
    knownHostPids: Iterable<number> = [],
): AgentRootRecord | null {
    const seen = new Set<number>()
    const consider = (root: AgentRootRecord | null): AgentRootRecord | null => {
        if (!root) return null
        if (agentRootContainmentActive(root)) return root
        clearAgentRoot(root.hostPid)
        return null
    }
    for (const hostPid of knownHostPids) {
        if (!Number.isSafeInteger(hostPid) || hostPid <= 0 || seen.has(hostPid)) continue
        seen.add(hostPid)
        const live = consider(readAgentRootForHost(hostPid))
        if (live) return live
    }
    const bySession = consider(readAgentRootForSession(sessionId))
    if (bySession) return bySession
    for (const root of listAgentRoots()) {
        if (seen.has(root.hostPid)) continue
        if (root.sessionId !== sessionId) continue
        const live = consider(root)
        if (live) return live
    }
    return null
}

/** True when a hostPid's published agent containment is still active. */
export function hostAgentContainmentActive(hostPid: number): boolean {
    const root = readAgentRootForHost(hostPid)
    if (!root) return false
    if (agentRootContainmentActive(root)) return true
    clearAgentRoot(hostPid)
    return false
}

/** Publish spawn identity for the current HAPI host process. */
export function publishAgentRootFromIdentity(
    identity: RetainedProcessIdentity,
    extras?: { sessionId?: string },
): void {
    const fromEnv = (process.env[HAPI_SESSION_ID_ENV] ?? '').trim()
    const sessionId = (extras?.sessionId ?? fromEnv) || undefined
    writeAgentRoot({
        hostPid: process.pid,
        pid: identity.pid,
        startMarker: identity.startMarker ?? getProcessStartMarker(identity.pid),
        bootId: identity.bootId,
        tgid: identity.tgid,
        pgid: identity.pgid,
        sessionId,
    })
}

export function clearAgentRootForCurrentHost(): void {
    clearAgentRoot(process.pid)
}
