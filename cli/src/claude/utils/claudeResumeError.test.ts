import { describe, expect, it } from 'vitest'
import { isUnrecoverableClaudeResumeError } from './claudeResumeError'

describe('isUnrecoverableClaudeResumeError', () => {
    it('classifies the "running as a background agent" rejection as unrecoverable', () => {
        const error = new Error(
            'Session 6f0c4551 is currently running as a background agent (bg). ' +
            'Use claude agents to find and attach to it, or add --fork-session to branch off a copy.'
        )
        expect(isUnrecoverableClaudeResumeError(error)).toBe(true)
    })

    it('classifies the interactive variant as unrecoverable', () => {
        const error = new Error('Session abc is currently running as an interactive agent.')
        expect(isUnrecoverableClaudeResumeError(error)).toBe(true)
    })

    it('matches the --fork-session hint regardless of surrounding wording', () => {
        const error = new Error('add --fork-session to branch off a copy')
        expect(isUnrecoverableClaudeResumeError(error)).toBe(true)
    })

    it('is case-insensitive', () => {
        const error = new Error('SESSION X IS CURRENTLY RUNNING AS A BACKGROUND AGENT')
        expect(isUnrecoverableClaudeResumeError(error)).toBe(true)
    })

    it('treats a transient process-exit error as recoverable (retryable)', () => {
        const error = new Error('Claude Code process exited with code 1')
        expect(isUnrecoverableClaudeResumeError(error)).toBe(false)
    })

    it('treats a spawn failure as recoverable (retryable)', () => {
        const error = new Error('Failed to spawn Claude Code process: ENOENT')
        expect(isUnrecoverableClaudeResumeError(error)).toBe(false)
    })

    it('handles non-Error values without throwing', () => {
        expect(isUnrecoverableClaudeResumeError('currently running as a background agent')).toBe(true)
        expect(isUnrecoverableClaudeResumeError(undefined)).toBe(false)
        expect(isUnrecoverableClaudeResumeError(null)).toBe(false)
    })
})
