import { describe, it, expect } from 'vitest'
import { resolveClaudeModePolicy } from './claudePermissionPolicy'

describe('resolveClaudeModePolicy', () => {
    it('routes question tools to the web regardless of mode', () => {
        for (const mode of ['default', 'bypassPermissions', 'acceptEdits', 'plan'] as const) {
            expect(resolveClaudeModePolicy(mode, 'AskUserQuestion')).toBe('web')
            expect(resolveClaudeModePolicy(mode, 'ask_user_question')).toBe('web')
            expect(resolveClaudeModePolicy(mode, 'request_user_input')).toBe('web')
        }
    })

    it('auto-allows everything except question tools under bypassPermissions', () => {
        expect(resolveClaudeModePolicy('bypassPermissions', 'Bash')).toBe('allow')
        expect(resolveClaudeModePolicy('bypassPermissions', 'Edit')).toBe('allow')
        expect(resolveClaudeModePolicy('bypassPermissions', 'Read')).toBe('allow')
    })

    it('auto-allows edit tools under acceptEdits', () => {
        expect(resolveClaudeModePolicy('acceptEdits', 'Edit')).toBe('allow')
        expect(resolveClaudeModePolicy('acceptEdits', 'Write')).toBe('allow')
        expect(resolveClaudeModePolicy('acceptEdits', 'MultiEdit')).toBe('allow')
        expect(resolveClaudeModePolicy('acceptEdits', 'NotebookEdit')).toBe('allow')
    })

    it('falls through for non-edit tools under acceptEdits', () => {
        expect(resolveClaudeModePolicy('acceptEdits', 'Bash')).toBe('fallthrough')
        expect(resolveClaudeModePolicy('acceptEdits', 'Read')).toBe('fallthrough')
    })

    it('falls through in default mode and for undefined mode', () => {
        expect(resolveClaudeModePolicy('default', 'Bash')).toBe('fallthrough')
        expect(resolveClaudeModePolicy('default', 'Edit')).toBe('fallthrough')
        expect(resolveClaudeModePolicy(undefined, 'Bash')).toBe('fallthrough')
    })
})
