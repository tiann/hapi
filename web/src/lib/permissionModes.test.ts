import { describe, expect, it } from 'vitest'
import { PERMISSION_MODES, type PermissionMode } from '@hapi/protocol'
import { isYoloStylePermissionMode } from '@/lib/permissionModes'

describe('isYoloStylePermissionMode', () => {
    it('names the modes the New Session form counts as YOLO, and no others', () => {
        const yolo: PermissionMode[] = []
        const other: PermissionMode[] = []
        for (const mode of PERMISSION_MODES) (isYoloStylePermissionMode(mode) ? yolo : other).push(mode)
        expect(yolo.sort()).toEqual(['always-proceed', 'bypassPermissions', 'safe-yolo', 'yolo'])
        expect(other).toContain('default')
        expect(other).toContain('acceptEdits')
        expect(other).toContain('plan')
        expect(other).toContain('read-only')
    })
})
