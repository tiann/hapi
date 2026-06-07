import { describe, expect, it } from 'bun:test'
import { extractFailingMermaidBlocks, buildMermaidRenderIssueHint } from './mermaid'

// Helper to wrap text in a Claude-style assistant message envelope
function assistantMessage(text: string): unknown {
    return {
        type: 'assistant',
        message: {
            role: 'assistant',
            content: [{ type: 'text', text }]
        }
    }
}

describe('extractFailingMermaidBlocks', () => {
    it('returns [] for non-assistant messages', () => {
        expect(extractFailingMermaidBlocks({ type: 'user', message: { role: 'user', content: 'hello' } })).toEqual([])
        expect(extractFailingMermaidBlocks(null)).toEqual([])
        expect(extractFailingMermaidBlocks('plain string')).toEqual([])
    })

    it('returns [] when no mermaid blocks present', () => {
        expect(extractFailingMermaidBlocks(assistantMessage('Here is some text with no diagrams.'))).toEqual([])
    })

    it('returns [] for valid diagram types', () => {
        const msg = assistantMessage('```mermaid\ngraph TD\n  A --> B\n```')
        expect(extractFailingMermaidBlocks(msg)).toEqual([])
    })

    it('returns [] for valid type with extra whitespace after type name', () => {
        const msg = assistantMessage('```mermaid\nflowchart LR\n  A --> B\n```')
        expect(extractFailingMermaidBlocks(msg)).toEqual([])
    })

    it('returns an issue for an unknown diagram type', () => {
        const msg = assistantMessage('```mermaid\ngrph TD\n  A --> B\n```')
        const issues = extractFailingMermaidBlocks(msg)
        expect(issues).toHaveLength(1)
        expect(issues[0].snippet).toContain('grph TD')
    })

    it('is case-insensitive for known types', () => {
        const msg = assistantMessage('```mermaid\nFLOWCHART TD\n  A --> B\n```')
        expect(extractFailingMermaidBlocks(msg)).toEqual([])
    })

    it('skips %%{init} config directives when determining diagram type', () => {
        const text = '```mermaid\n%%{init: {"theme": "base"}}%%\ngraph TD\n  A --> B\n```'
        expect(extractFailingMermaidBlocks(assistantMessage(text))).toEqual([])
    })

    it('detects an empty block as invalid', () => {
        const msg = assistantMessage('```mermaid\n\n```')
        const issues = extractFailingMermaidBlocks(msg)
        expect(issues).toHaveLength(1)
    })

    it('returns one issue per failing block, skips valid ones', () => {
        const text = [
            '```mermaid',
            'graph TD',
            '  A --> B',
            '```',
            '',
            'Some text',
            '',
            '```mermaid',
            'grph TD',
            '  A --> B',
            '```',
        ].join('\n')
        const issues = extractFailingMermaidBlocks(assistantMessage(text))
        expect(issues).toHaveLength(1)
        expect(issues[0].snippet).toContain('grph TD')
    })

    it('returns multiple issues when multiple blocks are invalid', () => {
        const text = [
            '```mermaid',
            'grph TD',
            '  A --> B',
            '```',
            '',
            '```mermaid',
            'sequenceDagram',
            '  A->>B: hello',
            '```',
        ].join('\n')
        const issues = extractFailingMermaidBlocks(assistantMessage(text))
        expect(issues).toHaveLength(2)
    })

    it('truncates snippet to 500 chars', () => {
        const longCode = 'unknowntype\n' + 'A --> B\n'.repeat(100)
        const msg = assistantMessage('```mermaid\n' + longCode + '\n```')
        const issues = extractFailingMermaidBlocks(msg)
        expect(issues).toHaveLength(1)
        expect(issues[0].snippet.length).toBeLessThanOrEqual(500)
    })
})

describe('buildMermaidRenderIssueHint', () => {
    it('wraps a single issue in render-issue tags', () => {
        const hint = buildMermaidRenderIssueHint([{ snippet: 'grph TD\n  A --> B' }])
        expect(hint).toMatch(/^<render-issue>/)
        expect(hint).toMatch(/<\/render-issue>$/)
        expect(hint).toContain('grph TD')
    })

    it('labels blocks when multiple issues', () => {
        const hint = buildMermaidRenderIssueHint([
            { snippet: 'grph TD\n  A --> B' },
            { snippet: 'sequenceDagram\n  A->>B: hi' }
        ])
        expect(hint).toContain('Block 1:')
        expect(hint).toContain('Block 2:')
    })

    it('does not label block when only one issue', () => {
        const hint = buildMermaidRenderIssueHint([{ snippet: 'grph TD' }])
        expect(hint).not.toContain('Block 1:')
    })
})
