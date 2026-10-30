import { describe, expect, it } from 'vitest'
import { buildHookSettings } from './generateHookSettings'

describe('buildHookSettings', () => {
    it('observes automatic compaction in both remote and local settings', () => {
        const settings = buildHookSettings('forward-cmd')
        expect(Object.keys(settings.hooks)).toEqual(['SessionStart', 'PreCompact'])
        expect(settings.hooks.SessionStart[0].hooks[0].command).toBe('forward-cmd')
        for (const settings of [buildHookSettings('forward-cmd'), buildHookSettings('forward-cmd', undefined, true, true)]) {
            expect(settings.hooks).toHaveProperty('PreCompact', [{
                matcher: 'auto',
                hooks: [{ type: 'command', command: 'forward-cmd' }]
            }])
        }
    })

    it('adds permission-mode-carrying hooks when trackPermissionMode is set', () => {
        const settings = buildHookSettings('forward-cmd', undefined, true)
        expect(settings.hooks.UserPromptSubmit?.[0].hooks[0].command).toBe('forward-cmd')
        expect(settings.hooks.PreToolUse?.[0].matcher).toBe('*')
        expect(settings.hooks.PreToolUse?.[0].hooks[0].command).toBe('forward-cmd')
        expect(settings.hooks.PostModelSwitch?.[0].hooks[0].command).toBe('forward-cmd')
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
        expect(settings.hooks.Stop).toBeDefined()
        expect(settings.hooks.StopFailure).toBeDefined()
        expect(buildHookSettings('forward-cmd', undefined, true, false).hooks.Stop).toBeUndefined()
        expect(settings.hooks.PermissionRequest?.[0].hooks[0]).toEqual({
            type: 'command',
            command: 'forward-cmd',
            timeout: 3600
        })
    })
})
