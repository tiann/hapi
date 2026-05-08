import { describe, expect, it } from 'vitest'
import { shouldShowInlineToolCardBody, shouldUseCompactTerminalToolCard } from '@/components/ToolCard/ToolCard'

describe('ToolCard terminal display mode helpers', () => {
    it('treats terminal-related cards as compact by default', () => {
        expect(shouldUseCompactTerminalToolCard('CodexBash', 'compact')).toBe(true)
        expect(shouldUseCompactTerminalToolCard('shell_command', 'compact')).toBe(true)
        expect(shouldUseCompactTerminalToolCard('run_shell_command', 'compact')).toBe(true)
        expect(shouldUseCompactTerminalToolCard('Read', 'compact')).toBe(false)
    })

    it('hides inline terminal previews in compact mode', () => {
        expect(shouldShowInlineToolCardBody('CodexBash', false, 'compact')).toBe(false)
    })

    it('keeps inline terminal previews in detailed mode', () => {
        expect(shouldShowInlineToolCardBody('CodexBash', false, 'detailed')).toBe(true)
        expect(shouldShowInlineToolCardBody('Bash', true, 'detailed')).toBe(true)
        expect(shouldShowInlineToolCardBody('shell_command', true, 'detailed')).toBe(true)
        expect(shouldShowInlineToolCardBody('run_shell_command', true, 'detailed')).toBe(true)
    })

    it('still hides inline bodies for minimal and Task/Agent subagent cards', () => {
        expect(shouldShowInlineToolCardBody('Task', false, 'detailed')).toBe(false)
        expect(shouldShowInlineToolCardBody('Agent', false, 'detailed')).toBe(false)
        expect(shouldShowInlineToolCardBody('Read', true, 'detailed')).toBe(false)
    })
})
