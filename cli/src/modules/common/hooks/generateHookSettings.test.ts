import { describe, expect, it } from 'vitest'
import { buildHookSettings } from './generateHookSettings'

describe('buildHookSettings', () => {
    it('registers only SessionStart by default', () => {
        const settings = buildHookSettings('forward-cmd')
        expect(Object.keys(settings.hooks)).toEqual(['SessionStart'])
        expect(settings.hooks.SessionStart[0].hooks[0].command).toBe('forward-cmd')
    })

    it('adds permission-mode-carrying hooks when trackPermissionMode is set', () => {
        const settings = buildHookSettings('forward-cmd', undefined, true)
        expect(settings.hooks.UserPromptSubmit?.[0].hooks[0].command).toBe('forward-cmd')
        expect(settings.hooks.PreToolUse?.[0].matcher).toBe('*')
        expect(settings.hooks.PreToolUse?.[0].hooks[0].command).toBe('forward-cmd')
    })
})

describe('buildHookSettings local approvals', () => {
    it('adds a long-lived PermissionRequest hook and observation-only lifecycle hooks', () => {
        const settings = buildHookSettings('forward-cmd', undefined, false, true)
        expect(settings.hooks.PermissionRequest?.[0].matcher).toBe('*')
        expect(settings.hooks.PreToolUse?.[0].hooks[0].timeout).toBeUndefined()
        expect(settings.hooks.PostToolUse).toBeDefined()
        expect(settings.hooks.PostToolUseFailure).toBeDefined()
        expect(settings.hooks.SessionEnd).toBeDefined()
        expect(settings.hooks.PermissionRequest?.[0].hooks[0]).toEqual({
            type: 'command',
            command: 'forward-cmd',
            timeout: 3600
        })
    })
})
