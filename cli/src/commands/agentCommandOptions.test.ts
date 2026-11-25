import { describe, expect, it } from 'vitest'
import { Flavors } from '@hapi/protocol/modes'
import { parseRemoteAgentCommandOptions } from './agentCommandOptions'

describe('parseRemoteAgentCommandOptions', () => {
    it('maps --yolo to the flavor\'s own auto-approve mode, not a hardcoded "yolo"', () => {
        // agy renamed its auto-approve mode to 'always-proceed'; 'yolo' is not a
        // valid agy mode, so --yolo must resolve to the flavor's equivalent.
        expect(parseRemoteAgentCommandOptions(['--yolo'], Flavors.agy.permissionModes).permissionMode)
            .toBe('always-proceed')
        // Flavors that DO have a 'yolo' mode keep it.
        expect(parseRemoteAgentCommandOptions(['--yolo'], Flavors.opencode.permissionModes).permissionMode)
            .toBe('yolo')
    })

    it('parses --hapi-session-id into reservedSessionId (fresh prealloc / adopt)', () => {
        // #1911 M3: must NOT alias to existingSessionId — that collapses adopt→reopen.
        // Intentional reopen uses --existing-session-id (buildCliArgs already splits).
        expect(parseRemoteAgentCommandOptions(['--hapi-session-id', 'hub-id-1'], Flavors.agy.permissionModes).reservedSessionId)
            .toBe('hub-id-1')
        expect(parseRemoteAgentCommandOptions(['--hapi-session-id', 'hub-id-1'], Flavors.agy.permissionModes).existingSessionId)
            .toBeUndefined()
    })

    it('parses common remote agent flags', () => {
        expect(parseRemoteAgentCommandOptions([
            '--started-by', 'runner',
            '--hapi-starting-mode', 'remote',
            '--existing-session-id', 'hapi-session-1',
            '--permission-mode', 'yolo',
            '--resume', 'session-1',
            '--model', 'model-a'
        ], Flavors.gemini.permissionModes)).toEqual({
            startedBy: 'runner',
            startingMode: 'remote',
            existingSessionId: 'hapi-session-1',
            permissionMode: 'yolo',
            resumeSessionId: 'session-1',
            model: 'model-a'
        })
    })

    it('parses --existing-session-id and rejects a missing value', () => {
        expect(parseRemoteAgentCommandOptions([
            '--existing-session-id', 'preallocated-hapi-id'
        ], Flavors.opencode.permissionModes).existingSessionId).toBe('preallocated-hapi-id')
        expect(() => parseRemoteAgentCommandOptions([
            '--existing-session-id'
        ], Flavors.opencode.permissionModes)).toThrow('Missing --existing-session-id value')
    })

    it('does not let --yolo override an explicit permission mode that appeared first', () => {
        expect(parseRemoteAgentCommandOptions([
            '--permission-mode', 'default',
            '--yolo'
        ], Flavors.opencode.permissionModes).permissionMode).toBe('default')
    })

    it('accepts OpenCode plan permission mode', () => {
        expect(parseRemoteAgentCommandOptions([
            '--permission-mode',
            'plan'
        ], Flavors.opencode.permissionModes).permissionMode).toBe('plan')
    })

    it('keeps current unknown-arg behavior by ignoring unrecognized flags', () => {
        expect(parseRemoteAgentCommandOptions([
            '--unknown',
            'value',
            '--model',
            'model-a'
        ], Flavors.gemini.permissionModes)).toEqual({
            model: 'model-a'
        })
    })

    it('rejects invalid constrained values', () => {
        expect(() => parseRemoteAgentCommandOptions([
            '--hapi-starting-mode',
            'sideways'
        ], Flavors.gemini.permissionModes)).toThrow('Invalid --hapi-starting-mode')

        expect(() => parseRemoteAgentCommandOptions([
            '--permission-mode',
            'bypassPermissions'
        ], Flavors.gemini.permissionModes)).toThrow('Invalid --permission-mode value')
    })

    it('parses model reasoning effort', () => {
        expect(parseRemoteAgentCommandOptions([
            '--model-reasoning-effort',
            'high'
        ], Flavors.opencode.permissionModes).modelReasoningEffort).toBe('high')
    })

    it('requires values for resume and model flags', () => {
        expect(() => parseRemoteAgentCommandOptions(['--resume'], Flavors.opencode.permissionModes)).toThrow('Missing --resume value')
        expect(() => parseRemoteAgentCommandOptions(['--model'], Flavors.opencode.permissionModes)).toThrow('Missing --model value')
        expect(() => parseRemoteAgentCommandOptions(['--model-reasoning-effort'], Flavors.opencode.permissionModes)).toThrow('Missing --model-reasoning-effort value')
        expect(() => parseRemoteAgentCommandOptions(['--existing-session-id'], Flavors.opencode.permissionModes)).toThrow('Missing --existing-session-id value')
    })

    it('accepts OpenCode-native -s / --session as resume aliases', () => {
        expect(parseRemoteAgentCommandOptions(
            ['-s', 'opencode-sess-1'],
            Flavors.opencode.permissionModes
        ).resumeSessionId).toBe('opencode-sess-1')

        expect(parseRemoteAgentCommandOptions(
            ['--session', 'opencode-sess-2'],
            Flavors.opencode.permissionModes
        ).resumeSessionId).toBe('opencode-sess-2')
    })

    it('rejects -s / --session with no value', () => {
        expect(() => parseRemoteAgentCommandOptions(['-s'], Flavors.opencode.permissionModes)).toThrow('Missing -s value')
        expect(() => parseRemoteAgentCommandOptions(['--session'], Flavors.opencode.permissionModes)).toThrow('Missing --session value')
    })

    it('a later -s overrides a prior --resume (last-write-wins)', () => {
        expect(parseRemoteAgentCommandOptions(
            ['--resume', 'first', '-s', 'second'],
            Flavors.opencode.permissionModes
        ).resumeSessionId).toBe('second')
    })
})

describe('parseRemoteAgentCommandOptions — pi flavor', () => {
    // Pi RPC mode has no permission switching, so the command passes an empty
    // allow-list. These tests cover the non-permission flags using a non-empty
    // allow-list purely as a parser fixture — the parser's behavior is
    // independent of the modes' contents.
    const ALLOWED = Flavors.opencode.permissionModes

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
                '--existing-session-id', 'hapi-session-pi-full',
            ],
            ALLOWED
        )
        expect(result).toEqual({
            startedBy: 'runner',
            startingMode: 'remote',
            model: 'claude-sonnet-4-5',
            resumeSessionId: 'pi-sess-full',
            existingSessionId: 'hapi-session-pi-full',
        })
    })
})
