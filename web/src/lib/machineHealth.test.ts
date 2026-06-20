import { describe, expect, it } from 'vitest'
import { presentMachineHealth } from './machineHealth'

describe('presentMachineHealth', () => {
    it('shows normalized load on unix-like platforms', () => {
        const result = presentMachineHealth({
            collectedAt: Date.now(),
            load1m: 2.4,
            cpuCount: 8,
            memoryPercent: 42
        }, 'linux')

        expect(result?.label).toBe('2.4/8')
        expect(result?.tone).toBe('ok')
        expect(result?.title).toContain('Load (1m): 2.4/8')
    })

    it('shows cpu percent on windows when load is absent', () => {
        const result = presentMachineHealth({
            collectedAt: Date.now(),
            cpuPercent: 88,
            memoryPercent: 70,
            cpuCount: 12
        }, 'win32')

        expect(result?.label).toBe('88% CPU')
        expect(result?.tone).toBe('warn')
    })

    it('returns null when health is missing', () => {
        expect(presentMachineHealth(null, 'linux')).toBeNull()
    })
})
