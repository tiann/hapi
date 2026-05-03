import { describe, expect, it } from 'vitest'
import { shouldEnableOpencodeModelDiscovery } from './opencodeModelsGate'

describe('shouldEnableOpencodeModelDiscovery', () => {
    const baseArgs = {
        agent: 'opencode' as const,
        machineId: 'machine-1',
        cwd: '/home/user/project',
        cwdExists: true,
    }

    it('enables discovery when agent, machine, and existing cwd are present', () => {
        expect(shouldEnableOpencodeModelDiscovery(baseArgs)).toBe(true)
    })

    it('disables discovery when cwd existence has not been confirmed yet', () => {
        // pathExistence[cwd] is undefined while the existence probe is in flight
        expect(
            shouldEnableOpencodeModelDiscovery({ ...baseArgs, cwdExists: undefined })
        ).toBe(false)
    })

    it('disables discovery when cwd does not exist on the machine', () => {
        // typing partial paths must not spawn an opencode acp probe for non-existent dirs
        expect(
            shouldEnableOpencodeModelDiscovery({ ...baseArgs, cwdExists: false })
        ).toBe(false)
    })

    it('disables discovery when agent is not opencode', () => {
        expect(
            shouldEnableOpencodeModelDiscovery({ ...baseArgs, agent: 'claude' })
        ).toBe(false)
    })

    it('disables discovery when machineId is missing', () => {
        expect(
            shouldEnableOpencodeModelDiscovery({ ...baseArgs, machineId: null })
        ).toBe(false)
    })

    it('disables discovery when cwd is empty', () => {
        expect(
            shouldEnableOpencodeModelDiscovery({ ...baseArgs, cwd: '' })
        ).toBe(false)
    })
})
