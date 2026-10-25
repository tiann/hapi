import { describe, expect, it } from 'vitest'
import {
    decideClaudeSessionFound,
    extractResumeIdFromClaudeArgs,
    resolveClaudeLocalResumeGuardId,
    resolveClaudeRemoteResumeTarget,
    resolveClaudeResumeGuardId
} from './claudeResumeGuard'

describe('decideClaudeSessionFound', () => {
    it('accepts a fresh session when nothing was requested', () => {
        expect(decideClaudeSessionFound({
            requestedId: null,
            reportedId: 'new-session-id'
        })).toEqual({ action: 'accept', sessionId: 'new-session-id' })
    })

    it('accepts when Claude continues the requested resume id', () => {
        expect(decideClaudeSessionFound({
            requestedId: 'aaaa-bbbb',
            reportedId: 'aaaa-bbbb'
        })).toEqual({ action: 'accept', sessionId: 'aaaa-bbbb' })
    })

    it('rejects silent overwrite when resume requested A but Claude reports B', () => {
        expect(decideClaudeSessionFound({
            requestedId: 'c66b46bc-7647-491a-9cd4-06ba640b9910',
            reportedId: '3e0eb081-1111-4111-8111-111111111111'
        })).toEqual({
            action: 'reject',
            requestedId: 'c66b46bc-7647-491a-9cd4-06ba640b9910',
            reportedId: '3e0eb081-1111-4111-8111-111111111111',
            reason: 'resume_mismatch'
        })
    })

    it('accepts a fork that mints a new id from the requested parent', () => {
        expect(decideClaudeSessionFound({
            requestedId: 'parent-id',
            reportedId: 'child-id',
            forkRequested: true
        })).toEqual({
            action: 'accept',
            sessionId: 'child-id',
            extras: { forkedFrom: 'parent-id' }
        })
    })
})

describe('resolveClaudeResumeGuardId', () => {
    it('prefers the in-memory session id (matches remote SDK target)', () => {
        expect(resolveClaudeResumeGuardId('session-a', ['--resume', 'session-b'])).toBe('session-a')
        expect(resolveClaudeRemoteResumeTarget('session-a', ['--resume', 'session-b'])).toBe('session-a')
    })

    it('falls back to --resume from claudeArgs when session id is null', () => {
        expect(resolveClaudeResumeGuardId(null, ['--resume', 'args-only-id'])).toBe('args-only-id')
        expect(extractResumeIdFromClaudeArgs(['--model', 'x', '--resume', 'aaaa-bbbb-cccc'])).toBe('aaaa-bbbb-cccc')
    })

    it('ignores --resume without a dashed session id value', () => {
        expect(extractResumeIdFromClaudeArgs(['--resume', '--verbose'])).toBeNull()
        expect(extractResumeIdFromClaudeArgs(['--resume'])).toBeNull()
    })
})

describe('resolveClaudeLocalResumeGuardId', () => {
    it('uses an explicit --resume id over the stored session id', () => {
        expect(resolveClaudeLocalResumeGuardId('session-a', ['--resume', 'session-b'])).toBe('session-b')
    })

    it('clears the guard when --continue overrides a stored id', () => {
        expect(resolveClaudeLocalResumeGuardId('session-a', ['--continue'])).toBeNull()
    })

    it('clears the guard for bare --resume without a UUID', () => {
        expect(resolveClaudeLocalResumeGuardId('session-a', ['--resume'])).toBeNull()
    })

    it('uses the stored session id when claudeArgs have no resume target', () => {
        expect(resolveClaudeLocalResumeGuardId('session-a', ['--verbose'])).toBe('session-a')
    })
})
