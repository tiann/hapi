import { describe, expect, it } from 'vitest'
import { GEMINI_PERMISSION_MODES, OPENCODE_PERMISSION_MODES, PI_PERMISSION_MODES } from '@hapi/protocol/modes'
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

describe('parseRemoteAgentCommandOptions — pi flavor', () => {
    it('accepts --model and stores it on options', () => {
        const result = parseRemoteAgentCommandOptions(
            ['--model', 'claude-sonnet-4-5'],
            PI_PERMISSION_MODES
        )
        expect(result.model).toBe('claude-sonnet-4-5')
    })

    it('--yolo resolves to yolo when no explicit --permission-mode is present', () => {
        const result = parseRemoteAgentCommandOptions(
            ['--yolo'],
            PI_PERMISSION_MODES
        )
        expect(result.permissionMode).toBe('yolo')
    })

    it('--permission-mode default resolves to default for pi', () => {
        const result = parseRemoteAgentCommandOptions(
            ['--permission-mode', 'default'],
            PI_PERMISSION_MODES
        )
        expect(result.permissionMode).toBe('default')
    })

    it('--permission-mode yolo resolves to yolo for pi', () => {
        const result = parseRemoteAgentCommandOptions(
            ['--permission-mode', 'yolo'],
            PI_PERMISSION_MODES
        )
        expect(result.permissionMode).toBe('yolo')
    })

    it('rejects --permission-mode plan (plan is not in PI_PERMISSION_MODES)', () => {
        expect(() => parseRemoteAgentCommandOptions(
            ['--permission-mode', 'plan'],
            PI_PERMISSION_MODES
        )).toThrow('Invalid --permission-mode value')
    })

    it('rejects --permission-mode acceptEdits (Claude-only)', () => {
        expect(() => parseRemoteAgentCommandOptions(
            ['--permission-mode', 'acceptEdits'],
            PI_PERMISSION_MODES
        )).toThrow('Invalid --permission-mode value')
    })

    it('rejects --permission-mode bypassPermissions (Claude-only)', () => {
        expect(() => parseRemoteAgentCommandOptions(
            ['--permission-mode', 'bypassPermissions'],
            PI_PERMISSION_MODES
        )).toThrow('Invalid --permission-mode value')
    })

    it('rejects --permission-mode read-only (Codex/Gemini/Kimi-only)', () => {
        expect(() => parseRemoteAgentCommandOptions(
            ['--permission-mode', 'read-only'],
            PI_PERMISSION_MODES
        )).toThrow('Invalid --permission-mode value')
    })

    it('--session-id stores the value as resumeSessionId (Pi-specific flag)', () => {
        // Pi uses --session-id for exact session resume (RPC mode), not the
        // generic --resume that other flavors use.
        const result = parseRemoteAgentCommandOptions(
            ['--session-id', 'pi-sess-123'],
            PI_PERMISSION_MODES
        )
        expect(result.resumeSessionId).toBe('pi-sess-123')
    })

    it('--resume is also accepted as an alias for session resume', () => {
        // Some flовerse paths pass --resume; the parser should accept it
        // uniformly so callers do not need to branch on flavor.
        const result = parseRemoteAgentCommandOptions(
            ['--resume', 'sess-id'],
            PI_PERMISSION_MODES
        )
        expect(result.resumeSessionId).toBe('sess-id')
    })

    it('a later --resume overrides a prior --session-id (last-write-wins)', () => {
        const result = parseRemoteAgentCommandOptions(
            ['--session-id', 'first', '--resume', 'second'],
            PI_PERMISSION_MODES
        )
        expect(result.resumeSessionId).toBe('second')
    })

    it('rejects --session-id with no value', () => {
        expect(() => parseRemoteAgentCommandOptions(
            ['--session-id'],
            PI_PERMISSION_MODES
        )).toThrow('Missing --session-id value')
    })

    it('parses --started-by runner', () => {
        const result = parseRemoteAgentCommandOptions(
            ['--started-by', 'runner'],
            PI_PERMISSION_MODES
        )
        expect(result.startedBy).toBe('runner')
    })

    it('parses --started-by terminal', () => {
        const result = parseRemoteAgentCommandOptions(
            ['--started-by', 'terminal'],
            PI_PERMISSION_MODES
        )
        expect(result.startedBy).toBe('terminal')
    })

    it('parses --hapi-starting-mode remote', () => {
        const result = parseRemoteAgentCommandOptions(
            ['--hapi-starting-mode', 'remote'],
            PI_PERMISSION_MODES
        )
        expect(result.startingMode).toBe('remote')
    })

    it('parses --hapi-starting-mode local', () => {
        const result = parseRemoteAgentCommandOptions(
            ['--hapi-starting-mode', 'local'],
            PI_PERMISSION_MODES
        )
        expect(result.startingMode).toBe('local')
    })

    it('rejects invalid --hapi-starting-mode', () => {
        expect(() => parseRemoteAgentCommandOptions(
            ['--hapi-starting-mode', 'invalid'],
            PI_PERMISSION_MODES
        )).toThrow('Invalid --hapi-starting-mode')
    })

    it('--yolo does not override an explicit earlier --permission-mode default', () => {
        const result = parseRemoteAgentCommandOptions(
            ['--permission-mode', 'default', '--yolo'],
            PI_PERMISSION_MODES
        )
        expect(result.permissionMode).toBe('default')
    })

    it('handles a full pi invocation end-to-end', () => {
        const result = parseRemoteAgentCommandOptions(
            [
                '--started-by', 'runner',
                '--hapi-starting-mode', 'remote',
                '--model', 'claude-sonnet-4-5',
                '--yolo',
                '--session-id', 'pi-sess-full',
            ],
            PI_PERMISSION_MODES
        )
        expect(result).toEqual({
            startedBy: 'runner',
            startingMode: 'remote',
            model: 'claude-sonnet-4-5',
            permissionMode: 'yolo',
            resumeSessionId: 'pi-sess-full',
        })
    })
})
