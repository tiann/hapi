import { describe, expect, it } from 'vitest'
import { buildAgyHooksJson, buildHookSettings } from './generateHookSettings'

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

describe('buildHookSettings PTY approvals', () => {
    it('adds a long-lived PreToolUse hook when includePreToolUse is set', () => {
        const settings = buildHookSettings('forward-cmd', undefined, false, true)
        expect(settings.hooks.PreToolUse?.[0].matcher).toBe('*')
        expect(settings.hooks.PreToolUse?.[0].hooks[0]).toEqual({
            type: 'command',
            command: 'forward-cmd',
            timeout: 3600
        })
    })
})


describe('buildAgyHooksJson', () => {
    it('produces a valid agy hooks.json with PreToolUse for all tools', () => {
        const parsed = JSON.parse(buildAgyHooksJson('hapi hook-forwarder --port 12345 --token abc')) as Record<string, { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string; timeout: number }> }> }>
        const group = Object.values(parsed)[0]
        expect(group.PreToolUse[0].matcher).toBe('*')
        expect(group.PreToolUse[0].hooks[0].command).toContain('hook-forwarder')
        expect(group.PreToolUse[0].hooks[0].timeout).toBeGreaterThanOrEqual(600)
    })

    it('accepts a custom hook name and omits Claude-only type', () => {
        const parsed = JSON.parse(buildAgyHooksJson('cmd', 'my-hook')) as Record<string, { PreToolUse: Array<{ hooks: Array<Record<string, unknown>> }> }>
        expect(parsed['my-hook']).toBeDefined()
        expect('type' in parsed['my-hook'].PreToolUse[0].hooks[0]).toBe(false)
    })
})
