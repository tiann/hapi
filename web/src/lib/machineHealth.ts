import type { Machine, MachineHealth } from '@/types/api'

export type MachineHealthPresentation = {
    label: string
    title: string
    tone: 'ok' | 'warn' | 'critical' | 'unknown'
}

function formatLoad(load1m: number, cpuCount?: number): string {
    if (cpuCount && cpuCount > 0) {
        return `${load1m.toFixed(1)}/${cpuCount}`
    }
    return load1m.toFixed(1)
}

function loadTone(load1m: number, cpuCount?: number): MachineHealthPresentation['tone'] {
    const cores = cpuCount && cpuCount > 0 ? cpuCount : 1
    const ratio = load1m / cores
    if (ratio >= 1.5) return 'critical'
    if (ratio >= 1) return 'warn'
    return 'ok'
}

function percentTone(value: number): MachineHealthPresentation['tone'] {
    if (value >= 90) return 'critical'
    if (value >= 75) return 'warn'
    return 'ok'
}

function worstTone(...tones: MachineHealthPresentation['tone'][]): MachineHealthPresentation['tone'] {
    if (tones.includes('critical')) return 'critical'
    if (tones.includes('warn')) return 'warn'
    if (tones.includes('unknown')) return 'unknown'
    return 'ok'
}

function buildTitle(health: MachineHealth, platform?: string | null): string {
    const parts: string[] = []
    if (health.cpuPercent !== undefined) {
        parts.push(`CPU: ${health.cpuPercent}%`)
    }
    if (health.memoryPercent !== undefined) {
        parts.push(`RAM: ${health.memoryPercent}%`)
    }
    if (health.load1m !== undefined && platform !== 'win32') {
        parts.push(`Load (1m): ${formatLoad(health.load1m, health.cpuCount)}`)
    }
    return parts.length > 0 ? parts.join(' · ') : 'Health unavailable'
}

function buildInlineLabel(health: MachineHealth): string | null {
    const parts: string[] = []
    if (health.cpuPercent !== undefined) {
        parts.push(`${health.cpuPercent}% CPU`)
    }
    if (health.memoryPercent !== undefined) {
        parts.push(`${health.memoryPercent}% RAM`)
    }
    return parts.length > 0 ? parts.join(' · ') : null
}

export function presentMachineHealth(
    health: MachineHealth | null | undefined,
    platform?: string | null
): MachineHealthPresentation | null {
    if (!health) {
        return null
    }

    const title = buildTitle(health, platform)
    const label = buildInlineLabel(health)
    if (label) {
        const tones: MachineHealthPresentation['tone'][] = []
        if (health.cpuPercent !== undefined) {
            tones.push(percentTone(health.cpuPercent))
        }
        if (health.memoryPercent !== undefined) {
            tones.push(percentTone(health.memoryPercent))
        }
        if (health.load1m !== undefined && platform !== 'win32') {
            tones.push(loadTone(health.load1m, health.cpuCount))
        }
        return {
            label,
            title,
            tone: worstTone(...tones)
        }
    }

    if (health.load1m !== undefined && platform !== 'win32') {
        return {
            label: `load ${formatLoad(health.load1m, health.cpuCount)}`,
            title,
            tone: loadTone(health.load1m, health.cpuCount)
        }
    }

    return {
        label: '—',
        title,
        tone: 'unknown'
    }
}

export function getMachinePlatform(machine: Machine | null | undefined): string | null {
    return machine?.metadata?.platform ?? null
}

export const MACHINE_HEALTH_TONE_CLASS: Record<MachineHealthPresentation['tone'], string> = {
    ok: 'text-[var(--app-hint)]',
    warn: 'text-[var(--app-badge-warning-text)]',
    critical: 'text-[var(--app-badge-error-text)]',
    unknown: 'text-[var(--app-hint)] opacity-70'
}
