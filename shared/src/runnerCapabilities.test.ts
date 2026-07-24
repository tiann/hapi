import { describe, expect, it } from 'vitest'
import {
    CURRENT_MACHINE_CAPABILITIES,
    MACHINE_CAPABILITIES,
    REQUIRED_MACHINE_CAPABILITIES,
    cliBinaryUpdatedOnDisk,
    isMachineCapabilitySkewed,
    missingRequiredCapabilities,
} from './runnerCapabilities'

describe('runnerCapabilities', () => {
    it('requires cursor-chat-store-status so hub features cannot fail-closed without a registry entry', () => {
        expect(REQUIRED_MACHINE_CAPABILITIES).toContain(MACHINE_CAPABILITIES.CursorChatStoreStatus)
        expect(CURRENT_MACHINE_CAPABILITIES).toEqual(expect.arrayContaining([
            ...REQUIRED_MACHINE_CAPABILITIES,
        ]))
    })

    it('treats missing/empty advertised capabilities as skewed', () => {
        expect(isMachineCapabilitySkewed(undefined)).toBe(true)
        expect(isMachineCapabilitySkewed(null)).toBe(true)
        expect(isMachineCapabilitySkewed([])).toBe(true)
        expect(missingRequiredCapabilities([])).toEqual([
            MACHINE_CAPABILITIES.CursorChatStoreStatus,
        ])
    })

    it('is not skewed when required capabilities are advertised', () => {
        expect(isMachineCapabilitySkewed([...CURRENT_MACHINE_CAPABILITIES])).toBe(false)
        expect(missingRequiredCapabilities([
            MACHINE_CAPABILITIES.CursorChatStoreStatus,
            'other-cap',
        ])).toEqual([])
    })

    it('detects on-disk CLI binary updates via mtime drift', () => {
        expect(cliBinaryUpdatedOnDisk({
            startedCliMtimeMs: 100,
            installedCliMtimeMs: 200,
        })).toBe(true)
        expect(cliBinaryUpdatedOnDisk({
            startedCliMtimeMs: 100,
            installedCliMtimeMs: 100,
        })).toBe(false)
        expect(cliBinaryUpdatedOnDisk({})).toBe(false)
        expect(cliBinaryUpdatedOnDisk(null)).toBe(false)
    })
})
