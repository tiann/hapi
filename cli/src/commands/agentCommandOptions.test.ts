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

    it('accepts OpenCode-native -s / --session as resume aliases', () => {
        expect(parseRemoteAgentCommandOptions(
            ['-s', 'opencode-sess-1'],
            OPENCODE_PERMISSION_MODES
        ).resumeSessionId).toBe('opencode-sess-1')

        expect(parseRemoteAgentCommandOptions(
            ['--session', 'opencode-sess-2'],
            OPENCODE_PERMISSION_MODES
        ).resumeSessionId).toBe('opencode-sess-2')
    })

    it('rejects -s / --session with no value', () => {
        expect(() => parseRemoteAgentCommandOptions(['-s'], OPENCODE_PERMISSION_MODES)).toThrow('Missing -s value')
        expect(() => parseRemoteAgentCommandOptions(['--session'], OPENCODE_PERMISSION_MODES)).toThrow('Missing --session value')
    })

    it('a later -s overrides a prior --resume (last-write-wins)', () => {
        expect(parseRemoteAgentCommandOptions(
            ['--resume', 'first', '-s', 'second'],
            OPENCODE_PERMISSION_MODES
        ).resumeSessionId).toBe('second')
    })
})

describe('parseRemoteAgentCommandOptions — pi flavor', () => {
    // Pi RPC mode has no permission switching, so the command passes an empty
    // allow-list. These tests cover the non-permission flags using a non-empty
    // allow-list purely as a parser fixture — the parser's behavior is
    // independent of the modes' contents.
    const ALLOWED = OPENCODE_PERMISSION_MODES

    it('accepts --model and stores it on options', () => {
        const result = parseRemoteAgentCommandOptions(
            ['--model', 'claude-sonnet-4-5'],
            ALLOWED
        )
        expect(result.model).toBe('claude-sonnet-4-5')
    })

    it('--session-id stores the value as resumeSessionId (Pi-specific flag)', () => {
        // Pi uses --session-id for exact session resume (RPC mode), not the
        // generic --resume that other flavors use.
        const result = parseRemoteAgentCommandOptions(
            ['--session-id', 'pi-sess-123'],
            ALLOWED
        )
        expect(result.resumeSessionId).toBe('pi-sess-123')
    })

    it('--resume is also accepted as an alias for session resume', () => {
        // Some flavor paths pass --resume; the parser should accept it
        // uniformly so callers do not need to branch on flavor.
        const result = parseRemoteAgentCommandOptions(
            ['--resume', 'sess-id'],
            ALLOWED
        )
        expect(result.resumeSessionId).toBe('sess-id')
    })

    it('a later --resume overrides a prior --session-id (last-write-wins)', () => {
        const result = parseRemoteAgentCommandOptions(
            ['--session-id', 'first', '--resume', 'second'],
            ALLOWED
        )
        expect(result.resumeSessionId).toBe('second')
    })

    it('rejects --session-id with no value', () => {
        expect(() => parseRemoteAgentCommandOptions(
            ['--session-id'],
            ALLOWED
        )).toThrow('Missing --session-id value')
    })

    it('parses --started-by runner', () => {
        const result = parseRemoteAgentCommandOptions(
            ['--started-by', 'runner'],
            ALLOWED
        )
        expect(result.startedBy).toBe('runner')
    })

    it('parses --started-by terminal', () => {
        const result = parseRemoteAgentCommandOptions(
            ['--started-by', 'terminal'],
            ALLOWED
        )
        expect(result.startedBy).toBe('terminal')
    })

    it('parses --hapi-starting-mode remote', () => {
        const result = parseRemoteAgentCommandOptions(
            ['--hapi-starting-mode', 'remote'],
            ALLOWED
        )
        expect(result.startingMode).toBe('remote')
    })

    it('parses --hapi-starting-mode local', () => {
        const result = parseRemoteAgentCommandOptions(
            ['--hapi-starting-mode', 'local'],
            ALLOWED
        )
        expect(result.startingMode).toBe('local')
    })

    it('rejects invalid --hapi-starting-mode', () => {
        expect(() => parseRemoteAgentCommandOptions(
            ['--hapi-starting-mode', 'invalid'],
            ALLOWED
        )).toThrow('Invalid --hapi-starting-mode')
    })

    it('handles a full pi invocation end-to-end', () => {
        const result = parseRemoteAgentCommandOptions(
            [
                '--started-by', 'runner',
                '--hapi-starting-mode', 'remote',
                '--model', 'claude-sonnet-4-5',
                '--session-id', 'pi-sess-full',
            ],
            ALLOWED
        )
        expect(result).toEqual({
            startedBy: 'runner',
            startingMode: 'remote',
            model: 'claude-sonnet-4-5',
            resumeSessionId: 'pi-sess-full',
        })
    })
})
