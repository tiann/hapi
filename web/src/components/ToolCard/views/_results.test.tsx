import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ToolCallBlock } from '@/chat/types'
import { extractCodexBashDisplay, extractTextFromResult, getMutationResultRenderMode, getToolResultViewComponent } from '@/components/ToolCard/views/_results'
import { I18nProvider } from '@/lib/i18n-context'

vi.mock('@/components/MarkdownRenderer', () => ({
    MarkdownRenderer: (props: { content: string; className?: string }) => (
        <div className={props.className}>{props.content}</div>
    )
}))

vi.mock('@/components/CodeBlock', () => ({
    CodeBlock: (props: { code: string; language?: string; title?: string; className?: string }) => (
        <div className={props.className}>
            {props.title ? <div>{props.title}</div> : null}
            <pre data-language={props.language ?? 'text'}>
                <code>{props.code}</code>
            </pre>
        </div>
    )
}))

describe('extractTextFromResult', () => {
    it('returns string directly', () => {
        expect(extractTextFromResult('hello')).toBe('hello')
    })

    it('extracts text from content block array', () => {
        const result = [{ type: 'text', text: 'File created successfully' }]
        expect(extractTextFromResult(result)).toBe('File created successfully')
    })

    it('joins multiple content blocks', () => {
        const result = [
            { type: 'text', text: 'Line 1' },
            { type: 'text', text: 'Line 2' }
        ]
        expect(extractTextFromResult(result)).toBe('Line 1\nLine 2')
    })

    it('extracts from object with content field', () => {
        expect(extractTextFromResult({ content: 'done' })).toBe('done')
    })

    it('extracts from object with text field', () => {
        expect(extractTextFromResult({ text: 'done' })).toBe('done')
    })

    it('extracts from object with output field', () => {
        expect(extractTextFromResult({ output: 'ok' })).toBe('ok')
    })

    it('extracts from object with error field', () => {
        expect(extractTextFromResult({ error: 'not found' })).toBe('not found')
    })

    it('returns null for null/undefined', () => {
        expect(extractTextFromResult(null)).toBeNull()
        expect(extractTextFromResult(undefined)).toBeNull()
    })

    it('strips tool_use_error tags', () => {
        const result = '<tool_use_error>Permission denied</tool_use_error>'
        expect(extractTextFromResult(result)).toBe('Permission denied')
    })
})

describe('getMutationResultRenderMode', () => {
    it('uses auto mode for short single-line success messages', () => {
        const result = getMutationResultRenderMode('Successfully wrote to /path/file.ts', 'completed')
        expect(result.mode).toBe('auto')
        expect(result.language).toBeUndefined()
    })

    it('uses auto mode for 3 lines or fewer', () => {
        const text = 'Line 1\nLine 2\nLine 3'
        const result = getMutationResultRenderMode(text, 'completed')
        expect(result.mode).toBe('auto')
    })

    it('uses code mode for multiline content (>3 lines) to avoid markdown mis-parsing', () => {
        const bashScript = '#!/bin/bash\n# Batch download\nset -e\ndownload() {\n  echo "downloading"\n}'
        const result = getMutationResultRenderMode(bashScript, 'completed')
        expect(result.mode).toBe('code')
        expect(result.language).toBe('text')
    })

    it('uses code mode for error state regardless of line count', () => {
        const result = getMutationResultRenderMode('Error: file not found', 'error')
        expect(result.mode).toBe('code')
        expect(result.language).toBe('text')
    })

    it('uses code mode for multiline error', () => {
        const text = 'Error\nStack trace:\n  at foo\n  at bar\n  at baz'
        const result = getMutationResultRenderMode(text, 'error')
        expect(result.mode).toBe('code')
    })
})

describe('extractCodexBashDisplay', () => {
    it('prefers stdout and keeps command metadata out of displayed output', () => {
        expect(extractCodexBashDisplay({
            command: '/bin/bash -lc pwd',
            cwd: '/tmp/project',
            stdout: '/tmp/project\n',
            exit_code: 0,
            status: 'completed'
        })).toEqual({
            stdout: '/tmp/project\n',
            stderr: null,
            exitCode: 0,
            status: 'completed'
        })
    })

    it('accepts legacy output as stdout fallback', () => {
        expect(extractCodexBashDisplay({
            output: 'ok\n',
            exitCode: 0
        })).toEqual({
            stdout: 'ok\n',
            stderr: null,
            exitCode: 0,
            status: null
        })
    })
})

describe('getToolResultViewComponent registry', () => {
    it('uses the same view for Write, Edit, MultiEdit, NotebookEdit', () => {
        const writeView = getToolResultViewComponent('Write')
        const editView = getToolResultViewComponent('Edit')
        const multiEditView = getToolResultViewComponent('MultiEdit')
        const notebookEditView = getToolResultViewComponent('NotebookEdit')
        expect(writeView).toBe(editView)
        expect(editView).toBe(multiEditView)
        expect(multiEditView).toBe(notebookEditView)
    })

    it('returns GenericResultView for mcp__ prefixed tools', () => {
        const mcpView = getToolResultViewComponent('mcp__test__tool')
        const unknownView = getToolResultViewComponent('SomeUnknownTool')
        // Both should fall back to GenericResultView
        expect(mcpView).toBe(unknownView)
    })

    it('uses a dedicated result view for CodexBash', () => {
        expect(getToolResultViewComponent('CodexBash')).not.toBe(getToolResultViewComponent('SomeUnknownTool'))
    })

    it('uses a dedicated result view for Codex agent tools', () => {
        expect(getToolResultViewComponent('spawn_agent')).not.toBe(getToolResultViewComponent('SomeUnknownTool'))
        expect(getToolResultViewComponent('wait_agent')).toBe(getToolResultViewComponent('spawn_agent'))
    })

    it('Agent falls back to GenericResultView (no dedicated view — view layer must not filter content)', () => {
        const agentView = getToolResultViewComponent('Agent')
        const genericView = getToolResultViewComponent('SomeUnknownTool')
        expect(agentView).toBe(genericView)
    })
})

describe('dialog result formatting', () => {
    const ResultView = getToolResultViewComponent('SomeUnknownTool')

    function renderResult(result: unknown) {
        const block: ToolCallBlock = {
            id: 'tool-1',
            localId: null,
            createdAt: 0,
            kind: 'tool-call',
            children: [],
            tool: {
                id: 'tool-1',
                name: 'SomeUnknownTool',
                state: 'completed',
                input: {},
                result,
                createdAt: 0,
                startedAt: null,
                completedAt: 0,
                description: null
            }
        }

        return render(
            <I18nProvider>
                <ResultView
                    block={block}
                    metadata={null}
                    surface="dialog"
                />
            </I18nProvider>
        )
    }

    it('quotes markdown result body without putting Raw JSON inside the quote', () => {
        const { container } = renderResult({ content: 'Done' })
        const quote = container.querySelector('[class*="border-l-"]')

        expect(quote).toHaveTextContent('Done')
        expect(quote).toHaveClass('tool-result-quote')
        expect(quote).not.toHaveTextContent('Raw JSON')
        expect(screen.getAllByText('Raw JSON').length).toBeGreaterThan(0)
    })

    it('does not quote a standalone fenced code block result', () => {
        const { container } = renderResult('```ts\nconst value = 1\n```')

        expect(container.querySelector('[class*="border-l-"]')).toBeNull()
        expect(container.querySelector('pre')).not.toBeNull()
        expect(container).toHaveTextContent('const value = 1')
    })
})

describe('Codex agent result formatting', () => {
    function renderToolResult(
        toolName: string,
        result: unknown,
        input: unknown = {},
        surface: 'inline' | 'dialog' = 'dialog'
    ) {
        const ResultView = getToolResultViewComponent(toolName)
        const block: ToolCallBlock = {
            id: 'tool-agent',
            localId: null,
            createdAt: 0,
            kind: 'tool-call',
            children: [],
            tool: {
                id: 'tool-agent',
                name: toolName,
                state: 'completed',
                input,
                result,
                createdAt: 0,
                startedAt: null,
                completedAt: 0,
                description: null
            }
        }

        return render(
            <I18nProvider>
                <ResultView block={block} metadata={null} surface={surface} />
            </I18nProvider>
        )
    }

    it('renders spawn_agent JSON output as launch metadata', () => {
        const { container } = renderToolResult(
            'spawn_agent',
            '{"agent_id":"agent-123","nickname":"Singer"}'
        )

        expect(container).toHaveTextContent('Agent launched')
        expect(container).toHaveTextContent('Singer')
        expect(container).toHaveTextContent('agent-123')
    })

    it('renders wait_agent completion output per agent', () => {
        const { container } = renderToolResult(
            'wait_agent',
            '{"status":{"agent-123":{"completed":"42。"}},"timed_out":false}',
            { targets: ['agent-123'] }
        )

        expect(container).toHaveTextContent('1 agent')
        expect(container).toHaveTextContent('completed')
        expect(container).toHaveTextContent('agent-123')
        expect(container).toHaveTextContent('42。')
    })

    it('hides wait_agent completion text inline', () => {
        const { container } = renderToolResult(
            'wait_agent',
            '{"status":{"agent-123":{"completed":"secret child output"}},"timed_out":false}',
            { targets: ['agent-123'] },
            'inline'
        )

        expect(container).toHaveTextContent('1 agent')
        expect(container).toHaveTextContent('1 completed')
        expect(container).not.toHaveTextContent('agent-123')
        expect(container).not.toHaveTextContent('secret child output')
    })

    it('renders close_agent previous status', () => {
        const { container } = renderToolResult(
            'close_agent',
            '{"previous_status":{"completed":"done"}}',
            { target: 'agent-123' }
        )

        expect(container).toHaveTextContent('Agent closed')
        expect(container).toHaveTextContent('agent-123')
        expect(container).toHaveTextContent('done')
    })

    it('hides close_agent previous status text inline', () => {
        const { container } = renderToolResult(
            'close_agent',
            '{"previous_status":{"completed":"secret close output"}}',
            { target: 'agent-123' },
            'inline'
        )

        expect(container).toHaveTextContent('Agent closed')
        expect(container).toHaveTextContent('agent-123')
        expect(container).not.toHaveTextContent('secret close output')
    })

    it('renders CodexAgent live activity while running without a result', () => {
        const ResultView = getToolResultViewComponent('CodexAgent')
        const block: ToolCallBlock = {
            id: 'tool-agent',
            localId: null,
            createdAt: 0,
            kind: 'tool-call',
            children: [],
            tool: {
                id: 'tool-agent',
                name: 'CodexAgent',
                state: 'running',
                input: {
                    summary: 'Inspect README',
                    activity: 'Reading file: README.md'
                },
                result: null,
                createdAt: 0,
                startedAt: 0,
                completedAt: null,
                description: null
            }
        }

        const { container } = render(
            <I18nProvider>
                <ResultView block={block} metadata={null} surface="inline" />
            </I18nProvider>
        )

        expect(container).toHaveTextContent('Reading file: README.md')
        expect(container).not.toHaveTextContent('Running…')
    })
})

describe('read file result formatting', () => {
    function renderToolResult(toolName: string, result: unknown, input: unknown = {}) {
        const ResultView = getToolResultViewComponent(toolName)
        const block: ToolCallBlock = {
            id: 'tool-read',
            localId: null,
            createdAt: 0,
            kind: 'tool-call',
            children: [],
            tool: {
                id: 'tool-read',
                name: toolName,
                state: 'completed',
                input,
                result,
                createdAt: 0,
                startedAt: null,
                completedAt: 0,
                description: null
            }
        }

        return render(
            <I18nProvider>
                <ResultView block={block} metadata={null} surface="dialog" />
            </I18nProvider>
        )
    }

    it('renders source file content as a code block', () => {
        const { container } = renderToolResult('Read', {
            file: {
                filePath: '/tmp/example.ts',
                content: 'const value = 1\nexport { value }'
            }
        })

        expect(container.querySelector('[class*="border-l-"]')).toBeNull()
        expect(container.querySelector('pre')).not.toBeNull()
        expect(container).toHaveTextContent('File content')
        expect(container).toHaveTextContent('const value = 1')
        expect(screen.getAllByText('Raw JSON').length).toBeGreaterThan(0)
    })

    it('renders plain read output as a quote', () => {
        const { container } = renderToolResult('Read', {
            file: {
                filePath: '/tmp/notes.txt',
                content: 'plain notes from the workspace'
            }
        })
        const quote = container.querySelector('[class*="border-l-"]')

        expect(quote).toHaveTextContent('plain notes from the workspace')
        expect(quote).toHaveClass('tool-result-quote')
        expect(quote?.querySelector('pre')).toBeNull()
        expect(screen.getAllByText('Raw JSON').length).toBeGreaterThan(0)
    })

    it('renders parsed Codex read command output as a quote', () => {
        const { container } = renderToolResult(
            'CodexBash',
            'Exit code: 0\nWall time: 0.1s\nOutput:\nhello from file',
            { parsed_cmd: [{ type: 'read', name: 'debug.txt' }] }
        )
        const quote = container.querySelector('[class*="border-l-"]')

        expect(quote).toHaveTextContent('hello from file')
        expect(quote?.querySelector('pre')).toBeNull()
    })

    it('renders parsed Codex read command source output as a code block', () => {
        const { container } = renderToolResult(
            'CodexBash',
            'Exit code: 0\nWall time: 0.1s\nOutput:\nconst value = 1',
            { parsed_cmd: [{ type: 'read', name: 'debug.ts' }] }
        )

        expect(container.querySelector('[class*="border-l-"]')).toBeNull()
        expect(container.querySelector('pre')).not.toBeNull()
        expect(container).toHaveTextContent('File content')
        expect(container).toHaveTextContent('const value = 1')
    })
})
