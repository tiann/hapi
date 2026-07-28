import { describe, expect, it } from 'vitest'
import { parseCursorCommandArgs } from './cursor'

describe('parseCursorCommandArgs', () => {
    it('accepts --mode autoReview', () => {
        expect(parseCursorCommandArgs(['--mode', 'autoReview']).permissionMode).toBe('autoReview')
    })

    it('accepts all Cursor permission modes via --mode', () => {
        for (const mode of ['default', 'plan', 'ask', 'debug', 'autoReview', 'yolo'] as const) {
            expect(parseCursorCommandArgs(['--mode', mode]).permissionMode).toBe(mode)
        }
    })

    it('rejects invalid --mode values', () => {
        expect(() => parseCursorCommandArgs(['--mode', 'not-a-mode'])).toThrow('Invalid --mode value')
        expect(() => parseCursorCommandArgs(['--mode'])).toThrow('Invalid --mode value')
    })

    it('accepts --auto-review shorthand', () => {
        expect(parseCursorCommandArgs(['--auto-review']).permissionMode).toBe('autoReview')
    })

    it('does not let --auto-review override an earlier --mode', () => {
        expect(
            parseCursorCommandArgs(['--mode', 'plan', '--auto-review']).permissionMode
        ).toBe('plan')
    })

    it('parses --cursor-worktree and --cursor-add-dir', () => {
        const opts = parseCursorCommandArgs([
            '--cursor-worktree',
            'feature-x',
            '--cursor-add-dir',
            '../shared'
        ])
        expect(opts.cursorWorktree).toBe('feature-x')
        expect(opts.cursorAddDirs).toEqual(['../shared'])
    })
})
