import { describe, it, expect } from 'vitest'
import { computeBackSyncedPermissionMode } from './backSyncPermissionMode'

describe('computeBackSyncedPermissionMode', () => {
    it('adopts the mode claude reports (e.g. user pressed Shift+Tab in the TUI)', () => {
        expect(computeBackSyncedPermissionMode('default', 'acceptEdits')).toBe('acceptEdits')
        expect(computeBackSyncedPermissionMode('acceptEdits', 'plan')).toBe('plan')
        // claude reports its default mode as "auto" — a valid hapi mode, taken as-is
        expect(computeBackSyncedPermissionMode('default', 'auto')).toBe('auto')
    })

    it('returns null when nothing changed (no redundant sync)', () => {
        expect(computeBackSyncedPermissionMode('acceptEdits', 'acceptEdits')).toBeNull()
        expect(computeBackSyncedPermissionMode('auto', 'auto')).toBeNull()
    })

    it('keeps yolo (bypassPermissions) hapi-only: claude mode never clobbers it', () => {
        // claude can't represent bypassPermissions (not in its Shift+Tab cycle),
        // so its reported mode must not pull a yolo session out of yolo.
        expect(computeBackSyncedPermissionMode('bypassPermissions', 'auto')).toBeNull()
        expect(computeBackSyncedPermissionMode('bypassPermissions', 'acceptEdits')).toBeNull()
        expect(computeBackSyncedPermissionMode('bypassPermissions', 'plan')).toBeNull()
    })

    it('never lets an inbound hook flip us INTO bypassPermissions', () => {
        expect(computeBackSyncedPermissionMode('default', 'bypassPermissions')).toBeNull()
    })

    it('ignores missing / invalid claude modes', () => {
        expect(computeBackSyncedPermissionMode('default', undefined)).toBeNull()
        expect(computeBackSyncedPermissionMode('default', '')).toBeNull()
        expect(computeBackSyncedPermissionMode('default', 'nonsense')).toBeNull()
    })
})
