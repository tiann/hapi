import { describe, expect, it } from 'vitest'
import { parseBerryCommandOptions } from './berry'

describe('parseBerryCommandOptions', () => {
    it('forces remote mode and accepts an existing HAPI row', () => {
        expect(parseBerryCommandOptions([
            '--hapi-starting-mode', 'remote',
            '--existing-session-id', 'hapi-session'
        ])).toEqual({
            startingMode: 'remote',
            existingSessionId: 'hapi-session'
        })
    })

    it('accepts native resume and model options plus the permission modes', () => {
        expect(parseBerryCommandOptions(['--resume', 'native-id', '--model', 'newapi/glm-5.3']))
            .toMatchObject({ resumeSessionId: 'native-id', model: 'newapi/glm-5.3', startingMode: 'remote' })
        expect(parseBerryCommandOptions(['--yolo']))
            .toMatchObject({ permissionMode: 'yolo', startingMode: 'remote' })
        expect(parseBerryCommandOptions(['--permission-mode', 'safe-yolo']))
            .toMatchObject({ permissionMode: 'safe-yolo', startingMode: 'remote' })
        // Berry maps read-only onto its native read-only sandbox axis.
        expect(parseBerryCommandOptions(['--permission-mode', 'read-only']))
            .toMatchObject({ permissionMode: 'read-only', startingMode: 'remote' })
        expect(() => parseBerryCommandOptions(['--permission-mode', 'bypassPermissions']))
            .toThrow('Invalid --permission-mode value')
    })

    it('rejects effort overrides owned by the Berry agent', () => {
        expect(() => parseBerryCommandOptions(['--effort', 'high']))
            .toThrow('effort')
        expect(() => parseBerryCommandOptions(['--model-reasoning-effort', 'high']))
            .toThrow('effort')
    })

    it('accepts a model override applied through the ACP config option', () => {
        expect(parseBerryCommandOptions(['--model', 'newapi/glm-5.3-flash'])).toEqual({
            model: 'newapi/glm-5.3-flash',
            startingMode: 'remote' as const
        })
    })
})
