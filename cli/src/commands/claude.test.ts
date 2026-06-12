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

    it('keeps the PreToolUse hook alive in PTY mode: --yolo does NOT forward --dangerously-skip-permissions', () => {
        const { options } = parseClaudeStartOptions(['--hapi-starting-mode', 'pty', '--yolo'])
        // pty is the interactive launch axis, not a control mode
        expect(options.interactive).toBe(true)
        expect(options.startingMode).toBeUndefined()
        // yolo semantics preserved internally...
        expect(options.permissionMode).toBe('bypassPermissions')
        // ...but the flag that would make claude bypass the hook is dropped, so
        // AskUserQuestion / permission requests still reach the web chat.
        expect(options.claudeArgs ?? []).not.toContain('--dangerously-skip-permissions')
    })

    it('strips an explicit --dangerously-skip-permissions in PTY mode too', () => {
        const { options } = parseClaudeStartOptions(['--hapi-starting-mode', 'pty', '--dangerously-skip-permissions'])
        expect(options.permissionMode).toBe('bypassPermissions')
        expect(options.claudeArgs ?? []).not.toContain('--dangerously-skip-permissions')
    })

    it('strips --dangerously-skip-permissions in PTY mode even with an explicit non-bypass mode', () => {
        // Regression: an explicit --permission-mode keeps the raw skip flag out of
        // the bypassPermissions branch, but in PTY mode the flag still disables the
        // PreToolUse hook the web bridge relies on, so it must be dropped regardless.
        const { options } = parseClaudeStartOptions([
            '--hapi-starting-mode',
            'pty',
            '--permission-mode',
            'default',
            '--dangerously-skip-permissions'
        ])
        expect(options.permissionMode).toBe('default')
        expect(options.claudeArgs ?? []).not.toContain('--dangerously-skip-permissions')
    })

    it('is arg-order independent (--yolo before --hapi-starting-mode pty)', () => {
        const { options } = parseClaudeStartOptions(['--yolo', '--hapi-starting-mode', 'pty'])
        expect(options.permissionMode).toBe('bypassPermissions')
        expect(options.claudeArgs ?? []).not.toContain('--dangerously-skip-permissions')
    })

    it('does not strip in local/remote mode (regression guard)', () => {
        for (const mode of ['local', 'remote'] as const) {
            const { options } = parseClaudeStartOptions(['--hapi-starting-mode', mode, '--yolo'])
            expect(options.claudeArgs).toContain('--dangerously-skip-permissions')
        }
    })

    it('captures --started-by and surfaces --help via showHelp', () => {
        const { options, showHelp } = parseClaudeStartOptions(['--started-by', 'runner', '--help'])
        expect(options.startedBy).toBe('runner')
        expect(showHelp).toBe(true)
    })
})
