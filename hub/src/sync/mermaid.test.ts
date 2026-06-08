import { describe, expect, it } from 'bun:test'
import { extractFailingMermaidBlocks, buildMermaidRenderIssueHint } from './mermaid'

// Bare { type:'assistant', message:... } envelope (e.g. test / older formats)
function assistantMessage(text: string): unknown {
    return {
        type: 'assistant',
        message: {
            role: 'assistant',
            content: [{ type: 'text', text }]
        }
    }
}

// role:'agent' + type:'output' — the real live-session format for Claude
function agentOutputMessage(text: string): unknown {
    return {
        role: 'agent',
        content: {
            type: 'output',
            data: {
                type: 'assistant',
                message: {
                    role: 'assistant',
                    content: [{ type: 'text', text }]
                }
            }
        },
        meta: { sentFrom: 'cli' }
    }
}

// role:'agent' + type:'codex' — Codex/Gemini/OpenCode format
function agentCodexMessage(text: string): unknown {
    return {
        role: 'agent',
        content: {
            type: 'codex',
            data: {
                type: 'message',
                message: text
            }
        },
        meta: { sentFrom: 'cli' }
    }
}

describe('extractFailingMermaidBlocks', () => {
    it('returns [] for non-assistant messages', () => {
        expect(extractFailingMermaidBlocks({ type: 'user', message: { role: 'user', content: 'hello' } })).toEqual([])
        expect(extractFailingMermaidBlocks(null)).toEqual([])
        expect(extractFailingMermaidBlocks('plain string')).toEqual([])
    })

    it('returns an issue for invalid mermaid in live-session agent output (Claude format)', () => {
        const msg = agentOutputMessage('```mermaid\ngrph TD\n  A --> B\n```')
        const issues = extractFailingMermaidBlocks(msg)
        expect(issues).toHaveLength(1)
        expect(issues[0].snippet).toContain('grph TD')
    })

    it('returns [] for valid mermaid in live-session agent output (Claude format)', () => {
        const msg = agentOutputMessage('```mermaid\ngraph TD\n  A --> B\n```')
        expect(extractFailingMermaidBlocks(msg)).toEqual([])
    })

    it('returns an issue for invalid mermaid in codex agent format', () => {
        const msg = agentCodexMessage('```mermaid\ngrph TD\n  A --> B\n```')
        const issues = extractFailingMermaidBlocks(msg)
        expect(issues).toHaveLength(1)
        expect(issues[0].snippet).toContain('grph TD')
    })

    it('returns [] for valid mermaid in codex agent format', () => {
        const msg = agentCodexMessage('```mermaid\nflowchart LR\n  A --> B\n```')
        expect(extractFailingMermaidBlocks(msg)).toEqual([])
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

    it('skips YAML frontmatter when determining diagram type', () => {
        const text = '```mermaid\n---\ntitle: My diagram\n---\ngraph TD\n  A --> B\n```'
        expect(extractFailingMermaidBlocks(assistantMessage(text))).toEqual([])
    })

    it('returns [] for mermaid 11.12+ diagram types (radar-beta, treemap, treeview-beta, venn-beta, wardley-beta, ishikawa)', () => {
        for (const type of ['radar-beta', 'treemap', 'treeView-beta', 'venn-beta', 'wardley-beta', 'ishikawa']) {
            const msg = assistantMessage(`\`\`\`mermaid\n${type}\n  A --> B\n\`\`\``)
            expect(extractFailingMermaidBlocks(msg), `should accept ${type}`).toEqual([])
        }
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
