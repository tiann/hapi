import { describe, expect, it } from 'vitest'
import { presentMachineHealth } from './machineHealth'

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
})
