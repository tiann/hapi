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

    it('accepts native resume while keeping model and HAPI permission controls managed by DSH ACP', () => {
        expect(parseDshCommandOptions(['--resume', 'native-id']))
            .toMatchObject({ resumeSessionId: 'native-id', startingMode: 'remote' })
        expect(() => parseDshCommandOptions(['--model', 'deepseek-v4-pro']))
            .toThrow('configured by the ACP server')
        expect(() => parseDshCommandOptions(['--yolo']))
            .toThrow('permission policy')
    })
})
