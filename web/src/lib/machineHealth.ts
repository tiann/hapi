import type { Machine, MachineHealth } from '@/types/api'

export type MachineHealthTone = 'ok' | 'warn' | 'critical' | 'unknown'

export type MachineHealthMetricPresentation = {
    id: 'cpu' | 'ram'
    shortLabel: 'CPU' | 'RAM'
    percent: number
    tone: MachineHealthTone
}

export type MachineDiskPresentation = {
    usedBytes: number
    totalBytes: number
    availableBytes: number
    /** `df` Use%: used / (used + available). */
    percent: number
    tone: MachineHealthTone
}

export type MachineHealthPresentation = {
    metrics: MachineHealthMetricPresentation[]
    /** Storage on the runner's home filesystem (where uploads land). */
    disk?: MachineDiskPresentation
    overallTone: MachineHealthTone
    loadDetail?: string
    uptimeDetail?: string
    cpuCount?: number
    status: 'healthy' | 'elevated' | 'high' | 'unknown'
}

/** Human size with binary units like `df -h` (162 GB, 9.5 GB, 512 MB). */
export function formatStorageBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return '—'
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
    let value = bytes
    let unit = 0
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024
        unit += 1
    }
    const digits = unit === 0 || value >= 10 ? 0 : 1
    return `${value.toFixed(digits)} ${units[unit]}`
}

function presentDisk(health: MachineHealth): MachineDiskPresentation | undefined {
    const { diskTotalBytes, diskUsedBytes, diskAvailableBytes } = health
    if (diskTotalBytes === undefined || diskUsedBytes === undefined || diskTotalBytes <= 0) {
        return undefined
    }
    const availableBytes = diskAvailableBytes ?? Math.max(0, diskTotalBytes - diskUsedBytes)
    const denominator = diskUsedBytes + availableBytes
    const percent = denominator > 0 ? Math.min(100, Math.ceil((diskUsedBytes / denominator) * 100)) : 0
    return {
        usedBytes: diskUsedBytes,
        totalBytes: diskTotalBytes,
        availableBytes,
        percent,
        tone: percent >= 95 ? 'critical' : percent >= 85 ? 'warn' : 'ok',
    }
}

/** Compact uptime for sidebar tiles, e.g. 1h 54m, 2d 4h, 5m. */
export function formatMachineUptimeSeconds(totalSeconds: number): string | null {
    if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
        return null
    }

    const seconds = Math.floor(totalSeconds)
    const days = Math.floor(seconds / 86_400)
    const hours = Math.floor((seconds % 86_400) / 3_600)
    const minutes = Math.floor((seconds % 3_600) / 60)

    if (days > 0) {
        return `${days}d ${hours}h`
    }
    if (hours > 0) {
        return `${hours}h ${minutes}m`
    }
    if (minutes > 0) {
        return `${minutes}m`
    }
    return `${seconds}s`
}

function formatLoad(load1m: number, cpuCount?: number): string {
    if (cpuCount && cpuCount > 0) {
        return `${load1m.toFixed(1)}/${cpuCount}`
    }
    return load1m.toFixed(1)
}

function loadTone(load1m: number, cpuCount?: number): MachineHealthTone {
    const cores = cpuCount && cpuCount > 0 ? cpuCount : 1
    const ratio = load1m / cores
    if (ratio >= 1.5) return 'critical'
    if (ratio >= 1) return 'warn'
    return 'ok'
}

function percentTone(value: number): MachineHealthTone {
    if (value >= 90) return 'critical'
    if (value >= 75) return 'warn'
    return 'ok'
}

function worstTone(...tones: MachineHealthTone[]): MachineHealthTone {
    if (tones.includes('critical')) return 'critical'
    if (tones.includes('warn')) return 'warn'
    if (tones.includes('unknown')) return 'unknown'
    return 'ok'
}

function statusFromTone(tone: MachineHealthTone): MachineHealthPresentation['status'] {
    if (tone === 'critical') return 'high'
    if (tone === 'warn') return 'elevated'
    if (tone === 'ok') return 'healthy'
    return 'unknown'
}

export function presentMachineHealth(
    health: MachineHealth | null | undefined,
    platform?: string | null
): MachineHealthPresentation | null {
    if (!health) {
        return null
    }

    const metrics: MachineHealthMetricPresentation[] = []
    const tones: MachineHealthTone[] = []

    if (health.cpuPercent !== undefined) {
        const tone = percentTone(health.cpuPercent)
        metrics.push({
            id: 'cpu',
            shortLabel: 'CPU',
            percent: health.cpuPercent,
            tone
        })
        tones.push(tone)
    }

    if (health.memoryPercent !== undefined) {
        const tone = percentTone(health.memoryPercent)
        metrics.push({
            id: 'ram',
            shortLabel: 'RAM',
            percent: health.memoryPercent,
            tone
        })
        tones.push(tone)
    }

    const loadDetail = health.load1m !== undefined && platform !== 'win32'
        ? formatLoad(health.load1m, health.cpuCount)
        : undefined
    const uptimeDetail = health.uptimeSeconds !== undefined
        ? formatMachineUptimeSeconds(health.uptimeSeconds)
        : undefined

    if (loadDetail !== undefined) {
        tones.push(loadTone(health.load1m!, health.cpuCount))
    }

    // Disk is shown alongside but does not drive the agent-capacity status.
    const disk = presentDisk(health)

    if (metrics.length === 0 && loadDetail === undefined && uptimeDetail === undefined) {
        return {
            metrics: [],
            ...(disk ? { disk } : {}),
            overallTone: 'unknown',
            status: 'unknown'
        }
    }

    const overallTone = metrics.length > 0 ? worstTone(...tones) : loadTone(health.load1m!, health.cpuCount)

    return {
        metrics,
        ...(disk ? { disk } : {}),
        overallTone,
        loadDetail,
        uptimeDetail: uptimeDetail ?? undefined,
        cpuCount: health.cpuCount,
        status: statusFromTone(overallTone)
    }
}

export function getMachinePlatform(machine: Machine | null | undefined): string | null {
    return machine?.metadata?.platform ?? null
}

export function getMachineHost(machine: Machine | null | undefined): string | null {
    return machine?.metadata?.host ?? null
}

export const MACHINE_HEALTH_BAR_FILL_CLASS: Record<MachineHealthTone, string> = {
    ok: 'bg-[var(--app-link)]/70',
    warn: 'bg-[var(--app-badge-warning-text)]',
    critical: 'bg-[var(--app-badge-error-text)]',
    unknown: 'bg-[var(--app-hint)]/50'
}

export const MACHINE_HEALTH_CHIP_CLASS: Record<MachineHealthTone, string> = {
    ok: 'border-[var(--app-border)] bg-[var(--app-subtle-bg)]/80',
    warn: 'border-[var(--app-badge-warning-border)] bg-[var(--app-badge-warning-bg)]/40',
    critical: 'border-[var(--app-badge-error-border)] bg-[var(--app-badge-error-bg)]/40',
    unknown: 'border-[var(--app-border)] bg-[var(--app-subtle-bg)]/60 opacity-70'
}

/** One-line summary for the sidebar machine row, e.g. "CPU 7% · RAM 37% · Disk 162 GB / 197 GB". */
export function formatMachineHealthInline(
    presentation: MachineHealthPresentation,
    diskLabel: string,
): string {
    const parts = presentation.metrics.map((metric) => `${metric.shortLabel} ${metric.percent}%`)
    if (presentation.disk) {
        parts.push(`${diskLabel} ${formatStorageBytes(presentation.disk.usedBytes)} / ${formatStorageBytes(presentation.disk.totalBytes)}`)
    }
    return parts.join(' · ')
}
