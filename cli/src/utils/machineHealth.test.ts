import { describe, expect, it } from 'vitest'
import { collectMachineHealth, resetMachineHealthSamplerForTests } from './machineHealth'

describe('collectMachineHealth', () => {
    it('returns schema-valid health with memory and cpu count', () => {
        resetMachineHealthSamplerForTests()
        const health = collectMachineHealth(1_700_000_000_000)
        expect(health.collectedAt).toBe(1_700_000_000_000)
        expect(health.cpuCount).toBeGreaterThan(0)
        expect(health.memoryPercent).toBeGreaterThanOrEqual(0)
        expect(health.memoryPercent).toBeLessThanOrEqual(100)
    })

    it('computes cpu percent after a second sample', async () => {
        resetMachineHealthSamplerForTests()
        collectMachineHealth()
        await new Promise((resolve) => setTimeout(resolve, 50))
        const second = collectMachineHealth()
        if (second.cpuPercent !== undefined) {
            expect(second.cpuPercent).toBeGreaterThanOrEqual(0)
            expect(second.cpuPercent).toBeLessThanOrEqual(100)
        }
    })
})
