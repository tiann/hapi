import { describe, expect, it } from 'vitest'
import { presentMachineHealth } from './machineHealth'

describe('presentMachineHealth', () => {
    it('shows cpu and ram together on unix-like platforms', () => {
        const result = presentMachineHealth({
            collectedAt: Date.now(),
            load1m: 2.4,
            cpuCount: 8,
            cpuPercent: 72,
            memoryPercent: 81
        }, 'linux')

        expect(result?.label).toBe('72% CPU · 81% RAM')
        expect(result?.tone).toBe('warn')
        expect(result?.title).toContain('CPU: 72%')
        expect(result?.title).toContain('RAM: 81%')
        expect(result?.title).toContain('Load (1m): 2.4/8')
    })

    it('uses the worst tone when cpu or ram is overloaded', () => {
        const result = presentMachineHealth({
            collectedAt: Date.now(),
            cpuPercent: 42,
            memoryPercent: 93
        }, 'linux')

        expect(result?.label).toBe('42% CPU · 93% RAM')
        expect(result?.tone).toBe('critical')
    })

    it('shows cpu and ram on windows when load is absent', () => {
        const result = presentMachineHealth({
            collectedAt: Date.now(),
            cpuPercent: 88,
            memoryPercent: 70,
            cpuCount: 12
        }, 'win32')

        expect(result?.label).toBe('88% CPU · 70% RAM')
        expect(result?.tone).toBe('warn')
        expect(result?.title).not.toContain('Load')
    })

    it('returns null when health is missing', () => {
        expect(presentMachineHealth(null, 'linux')).toBeNull()
    })
})
