import { describe, it, expect } from 'vitest'
import { parseClaudeStartOptions } from './claude'

describe('parseClaudeStartOptions', () => {
    it('maps --yolo to bypassPermissions and forwards --dangerously-skip-permissions', () => {
        const { options } = parseClaudeStartOptions(['--hapi-starting-mode', 'remote', '--yolo'])
        expect(options.startingMode).toBe('remote')
        expect(options.permissionMode).toBe('bypassPermissions')
        expect(options.claudeArgs).toContain('--dangerously-skip-permissions')
    })

    it('passes through model / effort / unknown args', () => {
        const { options } = parseClaudeStartOptions(['--model', 'opus', '--effort', 'high', '--resume', 'abc123'])
        expect(options.model).toBe('opus')
        expect(options.effort).toBe('high')
        expect(options.claudeArgs).toEqual(expect.arrayContaining(['--model', 'opus', '--effort', 'high', '--resume', 'abc123']))
    })

    it('honors an explicit --permission-mode and ignores a later --yolo', () => {
        const { options } = parseClaudeStartOptions(['--permission-mode', 'default', '--yolo'])
        expect(options.permissionMode).toBe('default')
        expect(options.claudeArgs ?? []).not.toContain('--dangerously-skip-permissions')
    })

    it('captures --started-by and surfaces --help via showHelp', () => {
        const { options, showHelp } = parseClaudeStartOptions(['--started-by', 'runner', '--help'])
        expect(options.startedBy).toBe('runner')
        expect(showHelp).toBe(true)
    })
})
