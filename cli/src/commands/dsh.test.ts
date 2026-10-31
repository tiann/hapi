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

    it('accepts native resume and model options while rejecting unsupported permission controls', () => {
        expect(parseDshCommandOptions(['--resume', 'native-id', '--model', 'deepseek-v4-pro']))
            .toMatchObject({ resumeSessionId: 'native-id', model: 'deepseek-v4-pro', startingMode: 'remote' })
        expect(() => parseDshCommandOptions(['--yolo']))
            .toThrow('permission policy')
    })

    it('accepts a model override applied through the ACP config option', () => {
        expect(parseDshCommandOptions(['--model', '["deepseek-official","deepseek-v4-pro"]']))
            .toEqual({
                model: '["deepseek-official","deepseek-v4-pro"]',
                startingMode: 'remote' as const
            })
    })
})
