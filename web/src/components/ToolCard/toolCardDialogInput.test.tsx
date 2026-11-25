import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ReactElement } from 'react'
import type { ChatToolCall, ToolCallBlock } from '@/chat/types'
import { ToolDetailDialogContent } from '@/components/ToolCard/ToolCard'
import { I18nProvider } from '@/lib/i18n-context'

function renderWithI18n(ui: ReactElement) {
    return render(<I18nProvider>{ui}</I18nProvider>)
}

function makeBlock(tool: Partial<ChatToolCall>): ToolCallBlock {
    return {
        kind: 'tool-call',
        id: 'tool-1',
        localId: null,
        createdAt: 0,
        tool: {
            id: 'tool-1',
            name: 'Bash',
            state: 'completed',
            input: { command: 'ls' },
            createdAt: 0,
            startedAt: 0,
            completedAt: 0,
            execStartedAt: null,
            execCompletedAt: null,
            description: null,
            result: 'ok',
            ...tool,
        },
        children: [],
    }
}

describe('ToolDetailDialogContent — shell input rendering', () => {
    it('renders the OpenCode bash command as a Command code block (not raw JSON)', () => {
        renderWithI18n(
            <ToolDetailDialogContent
                block={makeBlock({
                    name: 'bash',
                    input: { command: 'ls -la /tmp', cwd: '/workspace/demo', description: 'List files' },
                })}
                metadata={null}
            />
        )

        // Exactly one 'Input' label: the section heading (no JSON block title).
        expect(screen.getByText('Command')).toBeTruthy()
        expect(screen.getByText('ls -la /tmp')).toBeTruthy()
        expect(screen.getAllByText('Input')).toHaveLength(1)
    })

    it('renders the OpenCode command-name card (execute kind) as a Command code block', () => {
        renderWithI18n(
            <ToolDetailDialogContent
                block={makeBlock({
                    // OpenCode v2 titles the call after the raw command; the
                    // shell signal is the `execute` native kind on the wire.
                    name: 'ls',
                    nativeKind: 'execute',
                    input: { command: 'ls', description: 'List demo files', cwd: '/workspace/demo' },
                })}
                metadata={null}
            />
        )

        expect(screen.getByText('Command')).toBeTruthy()
        expect(screen.getByText('ls')).toBeTruthy()
        expect(screen.queryByText('cwd')).toBeNull()
        expect(screen.getAllByText('Input')).toHaveLength(1)
    })

    it('renders the shell result with line breaks preserved, not as markdown links', () => {
        const { container } = renderWithI18n(
            <ToolDetailDialogContent
                block={makeBlock({
                    name: 'ls',
                    nativeKind: 'execute',
                    input: { command: 'ls', description: 'List demo files' },
                    result: { output: 'README.md\npackage.json\nsrc\n', metadata: { status: 'completed', truncated: false, exit: 0 } },
                })}
                metadata={null}
            />
        )

        // Terminal result view (same as the canonical Bash card): monospace
        // preformatted output. The generic markdown view would collapse the
        // lines onto one and autolink the file names.
        expect(container.querySelector('pre')).not.toBeNull()
        expect(container.querySelector('a')).toBeNull()
        expect(container.textContent).toContain('README.md')
        expect(container.textContent).toContain('package.json')
        expect(container.textContent).toContain('src')
    })

    it('keeps the canonical Bash command block unchanged', () => {
        renderWithI18n(
            <ToolDetailDialogContent
                block={makeBlock({ name: 'Bash', input: { command: 'echo hi' } })}
                metadata={null}
            />
        )

        expect(screen.getByText('Command')).toBeTruthy()
        expect(screen.getByText('echo hi')).toBeTruthy()
        expect(screen.getAllByText('Input')).toHaveLength(1)
    })

    it('keeps the CodexBash command block unchanged', () => {
        renderWithI18n(
            <ToolDetailDialogContent
                block={makeBlock({ name: 'CodexBash', input: { command: 'cat README.md' } })}
                metadata={null}
            />
        )

        expect(screen.getByText('Command')).toBeTruthy()
        expect(screen.getByText('cat README.md')).toBeTruthy()
    })

    it('still renders raw JSON for non-shell tools', () => {
        const { container } = renderWithI18n(
            <ToolDetailDialogContent
                block={makeBlock({ name: 'Read', input: { file_path: 'src/a.ts' } })}
                metadata={null}
            />
        )

        expect(screen.queryByText('Command')).toBeNull()
        // Section heading plus the JSON block title.
        expect(screen.getAllByText('Input')).toHaveLength(2)
        expect(container.textContent).toContain('file_path')
    })
})