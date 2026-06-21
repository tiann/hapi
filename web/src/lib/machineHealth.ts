import type { Machine, MachineHealth } from '@/types/api'

export type MachineHealthTone = 'ok' | 'warn' | 'critical' | 'unknown'

export type MachineHealthMetricPresentation = {
    id: 'cpu' | 'ram'
    shortLabel: 'CPU' | 'RAM'
    percent: number
    tone: MachineHealthTone
}

export type MachineHealthPresentation = {
    metrics: MachineHealthMetricPresentation[]
    overallTone: MachineHealthTone
    loadDetail?: string
    cpuCount?: number
    status: 'healthy' | 'elevated' | 'high' | 'unknown'
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

    if (loadDetail !== undefined) {
        tones.push(loadTone(health.load1m!, health.cpuCount))
    }

    if (metrics.length === 0 && loadDetail === undefined) {
        return {
            metrics: [],
            overallTone: 'unknown',
            status: 'unknown'
        }
    }

    const overallTone = metrics.length > 0 ? worstTone(...tones) : loadTone(health.load1m!, health.cpuCount)

    return {
        metrics,
        overallTone,
        loadDetail,
        cpuCount: health.cpuCount,
        status: statusFromTone(overallTone)
    }
}

export function getCpuMetricTooltipLabel(
    cpuCount: number | undefined,
    t: (key: string, params?: Record<string, string | number>) => string
): string {
    if (cpuCount !== undefined && cpuCount > 0) {
        return t('machine.health.metric.cpuWithCount', { n: cpuCount })
    }
    return t('machine.health.metric.cpu')
}

export function getMachinePlatform(machine: Machine | null | undefined): string | null {
    return machine?.metadata?.platform ?? null
}

export function getMachineHost(machine: Machine | null | undefined): string | null {
    return machine?.metadata?.host ?? null
}

export type MachineOsLabel =
    | { kind: 'i18n'; key: 'machine.os.windows' | 'machine.os.linux' | 'machine.os.macos' | 'machine.os.unknown' }
    | { kind: 'raw'; value: string }

export function resolveMachineOsLabel(platform: string | null | undefined): MachineOsLabel {
    switch (platform) {
        case 'win32':
            return { kind: 'i18n', key: 'machine.os.windows' }
        case 'linux':
            return { kind: 'i18n', key: 'machine.os.linux' }
        case 'darwin':
            return { kind: 'i18n', key: 'machine.os.macos' }
        default:
            if (platform?.trim()) {
                return { kind: 'raw', value: platform.trim() }
            }
            return { kind: 'i18n', key: 'machine.os.unknown' }
    }
}

export function shouldShowMachineHostSubtitle(label: string, host: string | null | undefined): boolean {
    if (!host?.trim()) return false
    return host.trim().toLowerCase() !== label.trim().toLowerCase()
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
