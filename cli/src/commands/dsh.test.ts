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

    it('rejects native resume and HAPI permission controls unsupported by DSH ACP', () => {
        expect(() => parseDshCommandOptions(['--resume', 'native-id']))
            .toThrow('fresh sessions')
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
