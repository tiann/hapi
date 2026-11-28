import { describe, expect, it } from 'vitest'
import {
    formatMachineHealthInline,
    formatMachineUptimeSeconds,
    formatStorageBytes,
    presentMachineHealth,
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

describe('machine disk presentation', () => {
    const GiB = 1024 ** 3

    it('formats sizes with binary units like df -h', () => {
        expect(formatStorageBytes(162.5 * GiB)).toBe('163 GB')
        expect(formatStorageBytes(9.5 * GiB)).toBe('9.5 GB')
        expect(formatStorageBytes(512 * 1024 ** 2)).toBe('512 MB')
        expect(formatStorageBytes(2 * 1024 ** 4)).toBe('2.0 TB')
    })

    it('presents disk usage without changing the agent-capacity status', () => {
        const presentation = presentMachineHealth({
            collectedAt: 1,
            cpuPercent: 7,
            memoryPercent: 37,
            diskTotalBytes: 197 * GiB,
            diskUsedBytes: 163 * GiB,
            diskAvailableBytes: 26 * GiB,
        })
        expect(presentation?.disk).toMatchObject({ percent: 87, tone: 'warn' })
        expect(presentation?.status).toBe('healthy')
        expect(formatMachineHealthInline(presentation!, 'Disk')).toBe('CPU 7% · RAM 37% · Disk 163 GB / 197 GB')
    })

    it('omits disk when the runner does not report it', () => {
        const presentation = presentMachineHealth({ collectedAt: 1, cpuPercent: 7, memoryPercent: 37 })
        expect(presentation?.disk).toBeUndefined()
        expect(formatMachineHealthInline(presentation!, 'Disk')).toBe('CPU 7% · RAM 37%')
    })
})
