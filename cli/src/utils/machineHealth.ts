import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { availableParallelism, cpus, freemem, loadavg, platform, totalmem, uptime } from 'node:os'
import type { MachineHealth } from '@hapi/protocol/types'
import { MachineHealthSchema } from '@hapi/protocol/schemas'

type CpuTimesSnapshot = {
    idle: number
    total: number
}

let previousCpuSnapshot: CpuTimesSnapshot | null = null

function sumCpuTimes(): CpuTimesSnapshot | null {
    const cores = cpus()
    if (cores.length === 0) {
        return null
    }

    let idle = 0
    let total = 0
    for (const core of cores) {
        const times = core.times
        idle += times.idle
        total += times.user + times.nice + times.sys + times.idle + times.irq
    }

    return { idle, total }
}

function computeCpuPercent(current: CpuTimesSnapshot, previous: CpuTimesSnapshot): number | undefined {
    const idleDelta = current.idle - previous.idle
    const totalDelta = current.total - previous.total
    if (totalDelta <= 0) {
        return undefined
    }

    const usage = 1 - idleDelta / totalDelta
    return Math.max(0, Math.min(100, Math.round(usage * 100)))
}

function parseMeminfoKbValue(meminfo: string, key: string): number | undefined {
    for (const line of meminfo.split('\n')) {
        if (!line.startsWith(`${key}:`)) {
            continue
        }
        const kb = Number(line.split(/\s+/)[1])
        return Number.isFinite(kb) ? kb * 1024 : undefined
    }
    return undefined
}

/** Linux pressure percent: (MemTotal - MemAvailable) / MemTotal. Testable without /proc. */
export function readLinuxMemoryUsedPercent(meminfo: string): number | undefined {
    const total = parseMeminfoKbValue(meminfo, 'MemTotal')
    if (!total || total <= 0) {
        return undefined
    }

    const available = parseMeminfoKbValue(meminfo, 'MemAvailable')
    if (available !== undefined) {
        return Math.max(0, Math.min(100, Math.round(((total - available) / total) * 100)))
    }

    // Pre-3.14 kernels: approximate available as free + reclaimable cache.
    const free = parseMeminfoKbValue(meminfo, 'MemFree')
    if (free === undefined) {
        return undefined
    }
    const buffers = parseMeminfoKbValue(meminfo, 'Buffers') ?? 0
    const cached = parseMeminfoKbValue(meminfo, 'Cached') ?? 0
    const approxAvailable = free + buffers + cached
    return Math.max(0, Math.min(100, Math.round(((total - approxAvailable) / total) * 100)))
}

function parseVmStatPagesValue(vmStat: string, label: string): number | undefined {
    for (const line of vmStat.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed.startsWith(`${label}:`)) {
            continue
        }
        const match = trimmed.match(/(\d+)\.?\s*$/)
        if (!match) {
            return undefined
        }
        const pages = Number(match[1])
        return Number.isFinite(pages) ? pages : undefined
    }
    return undefined
}

function parseVmStatPageSize(vmStat: string): number | undefined {
    const match = vmStat.match(/page size of (\d+) bytes/)
    if (!match) {
        return undefined
    }
    const size = Number(match[1])
    return Number.isFinite(size) && size > 0 ? size : undefined
}

/**
 * Darwin used-memory percent, matching Activity Monitor's "Memory Used" figure:
 * App Memory + Wired + Compressed. It sums the anonymous (non-file-backed) resident
 * pages, the wired-down pages, and the pages occupied by the compressor — the
 * genuinely-occupied memory. Free and reclaimable file cache (inactive/speculative
 * file-backed pages) are simply not part of that sum.
 *
 * os.freemem() (total - free) instead counts reclaimable file cache as used, which is why
 * the pre-fix path reported a stuck ~99% "High pressure" on macOS. Summing occupied pages
 * keeps parity with the Linux branch, whose total - MemAvailable likewise treats reclaimable
 * cache as available and anonymous/wired memory as used. The three fields were validated on a
 * real Mac mini against `top`'s wired/compressor byte figures.
 *
 * Any unparseable required field — including the page-size header — returns undefined so the
 * caller falls back to os.freemem() rather than reporting a wrong-but-plausible percent.
 */
export function readDarwinMemoryUsedPercent(vmStat: string, totalBytes: number): number | undefined {
    if (!totalBytes || totalBytes <= 0) {
        return undefined
    }

    const pageSize = parseVmStatPageSize(vmStat)
    const anonymous = parseVmStatPagesValue(vmStat, 'Anonymous pages')
    const wired = parseVmStatPagesValue(vmStat, 'Pages wired down')
    const compressor = parseVmStatPagesValue(vmStat, 'Pages occupied by compressor')
    if (pageSize === undefined || anonymous === undefined || wired === undefined || compressor === undefined) {
        return undefined
    }

    const used = (anonymous + wired + compressor) * pageSize
    return Math.max(0, Math.min(100, Math.round((used / totalBytes) * 100)))
}

function computeMemoryPercent(): number | undefined {
    if (platform() === 'linux') {
        try {
            const fromProc = readLinuxMemoryUsedPercent(readFileSync('/proc/meminfo', 'utf8'))
            if (fromProc !== undefined) {
                return fromProc
            }
        } catch {
            // fall through to os.freemem()
        }
    }

    if (platform() === 'darwin') {
        try {
            const vmStat = execSync('vm_stat', { encoding: 'utf8', timeout: 1000 })
            const fromVmStat = readDarwinMemoryUsedPercent(vmStat, totalmem())
            if (fromVmStat !== undefined) {
                return fromVmStat
            }
        } catch {
            // fall through to os.freemem()
        }
    }

    const total = totalmem()
    if (total <= 0) {
        return undefined
    }

    const used = total - freemem()
    return Math.max(0, Math.min(100, Math.round((used / total) * 100)))
}

function isUnixLikeLoadPlatform(): boolean {
    return platform() !== 'win32'
}

function computeUptimeSeconds(): number | undefined {
    const seconds = uptime()
    if (!Number.isFinite(seconds) || seconds < 0) {
        return undefined
    }
    return Math.floor(seconds)
}

export function collectMachineHealth(now: number = Date.now()): MachineHealth {
    const cpuCount = availableParallelism()
    const memoryPercent = computeMemoryPercent()
    const uptimeSeconds = computeUptimeSeconds()
    const load1m = isUnixLikeLoadPlatform() ? loadavg()[0] : undefined

    const cpuSnapshot = sumCpuTimes()
    let cpuPercent: number | undefined
    if (cpuSnapshot && previousCpuSnapshot) {
        cpuPercent = computeCpuPercent(cpuSnapshot, previousCpuSnapshot)
    }
    if (cpuSnapshot) {
        previousCpuSnapshot = cpuSnapshot
    }

    const health = {
        collectedAt: now,
        cpuCount,
        ...(load1m !== undefined ? { load1m } : {}),
        ...(cpuPercent !== undefined ? { cpuPercent } : {}),
        ...(memoryPercent !== undefined ? { memoryPercent } : {}),
        ...(uptimeSeconds !== undefined ? { uptimeSeconds } : {})
    }

    const parsed = MachineHealthSchema.safeParse(health)
    if (!parsed.success) {
        return { collectedAt: now }
    }
    return parsed.data
}

/** Test helper */
export function resetMachineHealthSamplerForTests(): void {
    previousCpuSnapshot = null
}
