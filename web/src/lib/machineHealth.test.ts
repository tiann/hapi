import { describe, expect, it } from 'vitest'
import {
    formatMachineUptimeSeconds,
    presentMachineHealth,
    resolveMachineOsLabel,
    shouldShowMachineHostSubtitle,
} from './machineHealth'

describe('presentMachineHealth', () => {
    it('builds cpu and ram metrics for visual meters', () => {
        const result = presentMachineHealth({
            collectedAt: Date.now(),
            load1m: 2.4,
            cpuCount: 8,
            cpuPercent: 72,
            memoryPercent: 81
        }, 'linux')

        expect(result?.metrics).toEqual([
            { id: 'cpu', shortLabel: 'CPU', percent: 72, tone: 'ok' },
            { id: 'ram', shortLabel: 'RAM', percent: 81, tone: 'warn' }
        ])
        expect(result?.overallTone).toBe('warn')
        expect(result?.status).toBe('elevated')
        expect(result?.loadDetail).toBe('2.4/8')
        expect(result?.cpuCount).toBe(8)
    })

    it('marks high pressure when ram is critical', () => {
        const result = presentMachineHealth({
            collectedAt: Date.now(),
            cpuPercent: 42,
            memoryPercent: 93
        }, 'linux')

        expect(result?.overallTone).toBe('critical')
        expect(result?.status).toBe('high')
    })

    it('returns null when health is missing', () => {
        expect(presentMachineHealth(null, 'linux')).toBeNull()
    })

    it('formats uptime for tooltip and tile meta', () => {
        const result = presentMachineHealth({
            collectedAt: Date.now(),
            cpuPercent: 10,
            memoryPercent: 20,
            uptimeSeconds: 6_540,
        }, 'linux')

        expect(result?.uptimeDetail).toBe('1h 49m')
    })
})

describe('formatMachineUptimeSeconds', () => {
    it('formats days, hours, minutes, and seconds', () => {
        expect(formatMachineUptimeSeconds(90_000)).toBe('1d 1h')
        expect(formatMachineUptimeSeconds(3_720)).toBe('1h 2m')
        expect(formatMachineUptimeSeconds(300)).toBe('5m')
        expect(formatMachineUptimeSeconds(45)).toBe('45s')
    })
})

describe('resolveMachineOsLabel', () => {
    it('maps known platforms to i18n keys', () => {
        expect(resolveMachineOsLabel('win32')).toEqual({ kind: 'i18n', key: 'machine.os.windows' })
        expect(resolveMachineOsLabel('linux')).toEqual({ kind: 'i18n', key: 'machine.os.linux' })
        expect(resolveMachineOsLabel('darwin')).toEqual({ kind: 'i18n', key: 'machine.os.macos' })
    })

    it('falls back to raw platform string when unknown', () => {
        expect(resolveMachineOsLabel('freebsd')).toEqual({ kind: 'raw', value: 'freebsd' })
    })
})

describe('shouldShowMachineHostSubtitle', () => {
    it('hides host when it matches the display label', () => {
        expect(shouldShowMachineHostSubtitle('Teemo', 'Teemo')).toBe(false)
    })

    it('shows host when it differs from the display label', () => {
        expect(shouldShowMachineHostSubtitle('f9bb3c9e', 'proxmox')).toBe(true)
    })
})
