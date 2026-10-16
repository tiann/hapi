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

    it('rejects native resume and model controls unsupported by DSH ACP', () => {
        expect(() => parseDshCommandOptions(['--resume', 'native-id']))
            .toThrow('fresh sessions')
        expect(() => parseDshCommandOptions(['--model', 'deepseek-v4-pro']))
            .toThrow('configured by the ACP server')
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
