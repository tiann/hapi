import { availableParallelism, cpus, freemem, loadavg, platform, totalmem } from 'node:os'
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

function computeMemoryPercent(): number | undefined {
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

export function collectMachineHealth(now: number = Date.now()): MachineHealth {
    const cpuCount = availableParallelism()
    const memoryPercent = computeMemoryPercent()
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
        ...(memoryPercent !== undefined ? { memoryPercent } : {})
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
