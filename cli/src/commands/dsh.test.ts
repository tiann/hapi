import { describe, expect, it } from 'vitest'
import { parseDshCommandOptions } from './dsh'

describe('parseDshCommandOptions', () => {
    it('forces remote mode and accepts an existing HAPI row', () => {
        expect(parseDshCommandOptions([
            '--hapi-starting-mode', 'remote',
            '--existing-session-id', 'hapi-session'
        ])).toEqual({
            startingMode: 'remote',
            existingSessionId: 'hapi-session'
        })
    })

    it('accepts native resume and model options plus the spawn-time permission modes', () => {
        expect(parseDshCommandOptions(['--resume', 'native-id', '--model', 'deepseek-v4-pro']))
            .toMatchObject({ resumeSessionId: 'native-id', model: 'deepseek-v4-pro', startingMode: 'remote' })
        // --yolo maps onto the flavor's own auto-approve mode, pinned into the
        // child env as DSH_PERMISSION_MODE=danger-full-access at spawn.
        expect(parseDshCommandOptions(['--yolo']))
            .toMatchObject({ permissionMode: 'yolo', startingMode: 'remote' })
        expect(parseDshCommandOptions(['--permission-mode', 'read-only']))
            .toMatchObject({ permissionMode: 'read-only', startingMode: 'remote' })
        // Modes outside dsh's catalog stay rejected (claude's yolo alias is
        // not a dsh mode; --yolo resolves it to dsh's own 'yolo').
        expect(() => parseDshCommandOptions(['--permission-mode', 'bypassPermissions']))
            .toThrow('Invalid --permission-mode value: bypassPermissions')
    })

    it('accepts a model override applied through the ACP config option', () => {
        expect(parseDshCommandOptions(['--model', '["deepseek-official","deepseek-v4-pro"]']))
            .toEqual({
                model: '["deepseek-official","deepseek-v4-pro"]',
                startingMode: 'remote' as const
            })
    })
})
