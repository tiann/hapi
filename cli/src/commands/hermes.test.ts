import { describe, expect, it } from 'vitest'
import { parseHermesCommandOptions } from './hermes'

describe('parseHermesCommandOptions', () => {
    it('forces remote mode and accepts an existing HAPI row', () => {
        expect(parseHermesCommandOptions([
            '--hapi-starting-mode', 'remote',
            '--existing-session-id', 'hapi-session'
        ])).toEqual({
            startingMode: 'remote',
            existingSessionId: 'hapi-session'
        })
    })

    it('accepts native resume and model options plus the permission modes', () => {
        expect(parseHermesCommandOptions(['--resume', 'native-id', '--model', 'newapi:glm-5.3']))
            .toMatchObject({ resumeSessionId: 'native-id', model: 'newapi:glm-5.3', startingMode: 'remote' })
        expect(parseHermesCommandOptions(['--yolo']))
            .toMatchObject({ permissionMode: 'yolo', startingMode: 'remote' })
        expect(parseHermesCommandOptions(['--permission-mode', 'safe-yolo']))
            .toMatchObject({ permissionMode: 'safe-yolo', startingMode: 'remote' })
        // Hermes has no read-only mode — its edit-approval axis cannot honor it.
        expect(() => parseHermesCommandOptions(['--permission-mode', 'read-only']))
            .toThrow('Invalid --permission-mode value')
        expect(() => parseHermesCommandOptions(['--permission-mode', 'bypassPermissions']))
            .toThrow('Invalid --permission-mode value')
    })

    it('rejects effort overrides owned by the Hermes agent', () => {
        expect(() => parseHermesCommandOptions(['--effort', 'high']))
            .toThrow('effort')
        expect(() => parseHermesCommandOptions(['--model-reasoning-effort', 'high']))
            .toThrow('effort')
    })

    it('accepts a model override applied through the ACP config option', () => {
        expect(parseHermesCommandOptions(['--model', 'newapi:glm-5.3-flash'])).toEqual({
            model: 'newapi:glm-5.3-flash',
            startingMode: 'remote' as const
        })
    })
})
