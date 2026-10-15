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

    it('rejects model and HAPI permission controls unsupported by DSH ACP, accepts native resume', () => {
        expect(() => parseDshCommandOptions(['--model', 'deepseek-v4-pro']))
            .toThrow('configured by the ACP server')
        expect(() => parseDshCommandOptions(['--yolo']))
            .toThrow('permission policy')
        // --resume carries the native ACP session id (runner-emitted on reopen).
        expect(parseDshCommandOptions(['--resume', 'acp-session-1']))
            .toEqual({ resumeSessionId: 'acp-session-1', startingMode: 'remote' as const })
    })
})
