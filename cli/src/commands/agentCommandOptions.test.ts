import { describe, expect, it } from 'vitest'
import { GEMINI_PERMISSION_MODES, OPENCODE_PERMISSION_MODES } from '@hapi/protocol/modes'
import { parseRemoteAgentCommandOptions } from './agentCommandOptions'

describe('parseRemoteAgentCommandOptions', () => {
    it('parses common remote agent flags', () => {
        expect(parseRemoteAgentCommandOptions([
            '--started-by', 'runner',
            '--hapi-starting-mode', 'remote',
            '--permission-mode', 'yolo',
            '--resume', 'session-1',
            '--model', 'model-a'
        ], GEMINI_PERMISSION_MODES)).toEqual({
            startedBy: 'runner',
            startingMode: 'remote',
            permissionMode: 'yolo',
            resumeSessionId: 'session-1',
            model: 'model-a'
        })
    })

    it('does not let --yolo override an explicit permission mode that appeared first', () => {
        expect(parseRemoteAgentCommandOptions([
            '--permission-mode', 'default',
            '--yolo'
        ], OPENCODE_PERMISSION_MODES).permissionMode).toBe('default')
    })

    it('accepts OpenCode plan permission mode', () => {
        expect(parseRemoteAgentCommandOptions([
            '--permission-mode',
            'plan'
        ], OPENCODE_PERMISSION_MODES).permissionMode).toBe('plan')
    })

    it('keeps current unknown-arg behavior by ignoring unrecognized flags', () => {
        expect(parseRemoteAgentCommandOptions([
            '--unknown',
            'value',
            '--model',
            'model-a'
        ], GEMINI_PERMISSION_MODES)).toEqual({
            model: 'model-a'
        })
    })

    it('rejects invalid constrained values', () => {
        expect(() => parseRemoteAgentCommandOptions([
            '--hapi-starting-mode',
            'sideways'
        ], GEMINI_PERMISSION_MODES)).toThrow('Invalid --hapi-starting-mode')

        expect(() => parseRemoteAgentCommandOptions([
            '--permission-mode',
            'bypassPermissions'
        ], GEMINI_PERMISSION_MODES)).toThrow('Invalid --permission-mode value')
    })

    it('parses model reasoning effort', () => {
        expect(parseRemoteAgentCommandOptions([
            '--model-reasoning-effort',
            'high'
        ], OPENCODE_PERMISSION_MODES).modelReasoningEffort).toBe('high')
    })

    it('requires values for resume and model flags', () => {
        expect(() => parseRemoteAgentCommandOptions(['--resume'], OPENCODE_PERMISSION_MODES)).toThrow('Missing --resume value')
        expect(() => parseRemoteAgentCommandOptions(['--model'], OPENCODE_PERMISSION_MODES)).toThrow('Missing --model value')
        expect(() => parseRemoteAgentCommandOptions(['--model-reasoning-effort'], OPENCODE_PERMISSION_MODES)).toThrow('Missing --model-reasoning-effort value')
    })
})
