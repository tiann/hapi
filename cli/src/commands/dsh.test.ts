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
        expect(() => parseDshCommandOptions(['--effort', 'high']))
            .toThrow('configured by the ACP server')
        // --resume carries the native ACP session id (runner-emitted on reopen).
        expect(parseDshCommandOptions(['--resume', 'acp-session-1']))
            .toEqual({ resumeSessionId: 'acp-session-1', startingMode: 'remote' as const })
    })

    it('accepts a model override applied through the ACP config option', () => {
        expect(parseDshCommandOptions(['--model', '["deepseek-official","deepseek-v4-pro"]']))
            .toEqual({
                model: '["deepseek-official","deepseek-v4-pro"]',
                startingMode: 'remote' as const
            })
    })

    it('maps --yolo to the yolo permission mode', () => {
        expect(parseDshCommandOptions(['--yolo'])).toEqual({
            startingMode: 'remote',
            permissionMode: 'yolo'
        })
    })

    it('accepts an explicit --permission-mode from the DSH mode set', () => {
        expect(parseDshCommandOptions(['--permission-mode', 'safe-yolo'])).toEqual({
            startingMode: 'remote',
            permissionMode: 'safe-yolo'
        })
        expect(() => parseDshCommandOptions(['--permission-mode', 'plan']))
            .toThrow('Invalid --permission-mode value')
    })
})
