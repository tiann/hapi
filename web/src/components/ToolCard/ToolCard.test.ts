import { describe, expect, it } from 'vitest'
import { formatSubagentModelLabel, getSubagentModel, shouldShowInlineToolCardBody, shouldUseCompactTerminalToolCard } from '@/components/ToolCard/ToolCard'
import type { AgentTextBlock, ChatBlock, ToolCallBlock } from '@/chat/types'

function makeAgentTextBlock(overrides: Partial<AgentTextBlock> = {}): AgentTextBlock {
    return {
        kind: 'agent-text',
        id: 'agent-text-1',
        localId: null,
        createdAt: 0,
        text: 'hello',
        model: null,
        ...overrides
    }
}

function makeToolCallChild(overrides: Partial<ToolCallBlock> = {}): ToolCallBlock {
    return {
        kind: 'tool-call',
        id: 'tool-1',
        localId: null,
        createdAt: 0,
        model: null,
        tool: {
            id: 'tool-1',
            name: 'Bash',
            state: 'completed',
            input: {},
            createdAt: 0,
            startedAt: 0,
            completedAt: 0,
            execStartedAt: null,
            execCompletedAt: null,
            description: null
        },
        children: [],
        ...overrides
    }
}

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

describe('formatSubagentModelLabel', () => {
    it('uses getClaudeModelLabel for a preset alias', () => {
        expect(formatSubagentModelLabel('opus')).toBe('Opus')
        expect(formatSubagentModelLabel('sonnet[1m]')).toBe('Sonnet 1M')
    })

    it('extracts name + version from a full SDK model id, dropping the date suffix', () => {
        expect(formatSubagentModelLabel('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5')
        expect(formatSubagentModelLabel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
        expect(formatSubagentModelLabel('claude-opus-4-8')).toBe('Opus 4.8')
    })

    it('falls back to the raw string for formats it does not recognize', () => {
        expect(formatSubagentModelLabel('gemini-3-flash-preview')).toBe('gemini-3-flash-preview')
        expect(formatSubagentModelLabel('some-completely-unfamiliar-id')).toBe('some-completely-unfamiliar-id')
    })
})

describe('getSubagentModel', () => {
    it('returns null when there are no children', () => {
        expect(getSubagentModel([])).toBeNull()
    })

    it('returns null when no child carries a model', () => {
        const children: ChatBlock[] = [makeAgentTextBlock({ model: null }), makeToolCallChild({ model: null })]
        expect(getSubagentModel(children)).toBeNull()
    })

    it('returns the single formatted model when every carrying child agrees, across mixed block kinds', () => {
        const children: ChatBlock[] = [
            makeToolCallChild({ model: null }),
            makeAgentTextBlock({ model: 'claude-haiku-4-5-20251001' }),
            makeAgentTextBlock({ model: 'claude-haiku-4-5-20251001' })
        ]
        expect(getSubagentModel(children)).toBe('Haiku 4.5')
    })

    it('picks up a non-null model from a ToolCallBlock child, not just AgentTextBlock', () => {
        const children: ChatBlock[] = [
            makeAgentTextBlock({ model: null }),
            makeToolCallChild({ model: 'claude-haiku-4-5-20251001' })
        ]
        expect(getSubagentModel(children)).toBe('Haiku 4.5')
    })

    it('joins distinct formatted models in first-seen order when the subagent switches mid-run (e.g. --fallback-model)', () => {
        const children: ChatBlock[] = [
            makeAgentTextBlock({ model: 'claude-sonnet-4-5-20250929' }),
            makeAgentTextBlock({ model: 'claude-haiku-4-5-20251001' })
        ]
        expect(getSubagentModel(children)).toBe('Sonnet 4.5, Haiku 4.5')
    })

    it('dedups a raw model value that repeats across turns instead of listing it twice', () => {
        const children: ChatBlock[] = [
            makeAgentTextBlock({ model: 'claude-sonnet-4-5-20250929' }),
            makeAgentTextBlock({ model: 'claude-haiku-4-5-20251001' }),
            makeAgentTextBlock({ model: 'claude-sonnet-4-5-20250929' })
        ]
        expect(getSubagentModel(children)).toBe('Sonnet 4.5, Haiku 4.5')
    })

    it('ignores empty-string model values', () => {
        const children: ChatBlock[] = [makeAgentTextBlock({ model: '' }), makeAgentTextBlock({ model: 'claude-haiku-4-5-20251001' })]
        expect(getSubagentModel(children)).toBe('Haiku 4.5')
    })
})
