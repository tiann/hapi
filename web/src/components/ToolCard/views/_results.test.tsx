import { describe, expect, it } from 'vitest'
import { afterEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { ToolCallBlock } from '@/chat/types'
import { extractTextFromResult, getMutationResultRenderMode, getToolResultViewComponent, toolResultViewRegistry } from '@/components/ToolCard/views/_results'
import { I18nProvider } from '@/lib/i18n-context'

function makeToolBlock(name: string, result: unknown, input: unknown = {}): ToolCallBlock {
    return {
        kind: 'tool-call',
        id: `${name}-block`,
        localId: null,
        createdAt: 0,
        tool: {
            id: `${name}-tool`,
            name,
            state: 'completed',
            input,
            createdAt: 0,
            startedAt: 0,
            completedAt: 0,
            description: null,
            result
        },
        children: []
    }
}

function renderWithProviders(ui: React.ReactElement) {
    if (typeof window !== 'undefined' && !window.matchMedia) {
        window.matchMedia = () => ({
            matches: false,
            media: '',
            onchange: null,
            addListener: () => {},
            removeListener: () => {},
            addEventListener: () => {},
            removeEventListener: () => {},
            dispatchEvent: () => false
        })
    }

    return render(
        <I18nProvider>
            {ui}
        </I18nProvider>
    )
}

afterEach(() => {
    cleanup()
})

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

    it('routes Codex aliases to dedicated result views', () => {
        expect(toolResultViewRegistry.CodexBash).toBeDefined()
        expect(toolResultViewRegistry.CodexWriteStdin).toBeDefined()
        expect(toolResultViewRegistry.CodexSpawnAgent).toBeDefined()
        expect(toolResultViewRegistry.CodexWaitAgent).toBeDefined()
        expect(toolResultViewRegistry.CodexSendInput).toBeDefined()
        expect(toolResultViewRegistry.CodexCloseAgent).toBeDefined()
    })

    it('routes Codex subagent tools away from GenericResultView', () => {
        const generic = getToolResultViewComponent('SomeUnknownTool')

        expect(getToolResultViewComponent('CodexWriteStdin')).not.toBe(generic)
        expect(getToolResultViewComponent('CodexSpawnAgent')).not.toBe(generic)
        expect(getToolResultViewComponent('CodexWaitAgent')).not.toBe(generic)
        expect(getToolResultViewComponent('CodexSendInput')).not.toBe(generic)
        expect(getToolResultViewComponent('CodexCloseAgent')).not.toBe(generic)
    })

    it('routes Claude parity tool names to expected result views', () => {
        expect(getToolResultViewComponent('BashOutput')).toBe(getToolResultViewComponent('Bash'))
        expect(getToolResultViewComponent('KillBash')).toBe(getToolResultViewComponent('SomeUnknownTool'))
        expect(getToolResultViewComponent('TodoRead')).toBe(getToolResultViewComponent('TodoWrite'))
        expect(getToolResultViewComponent('EnterWorktree')).toBe(getToolResultViewComponent('SomeUnknownTool'))
    })
})

describe('Codex alias result rendering', () => {
    it('renders CodexBash object stdout and stderr output', () => {
        const View = getToolResultViewComponent('CodexBash')

        renderWithProviders(
            <View
                block={makeToolBlock('CodexBash', {
                    stdout: 'command ok',
                    stderr: 'warning output'
                })}
                metadata={null}
            />
        )

        expect(screen.getByText('command ok')).toBeInTheDocument()
        expect(screen.getByText('warning output')).toBeInTheDocument()
    })

    it('renders TodoRead checklist entries through parity routing', () => {
        const View = getToolResultViewComponent('TodoRead')

        renderWithProviders(
            <View
                block={makeToolBlock('TodoRead', {
                    newTodos: [
                        { id: 'todo-1', content: 'Ship web parity', status: 'completed' }
                    ]
                })}
                metadata={null}
            />
        )

        expect(screen.getByText(/Ship web parity/)).toBeInTheDocument()
    })

    it('renders CodexWriteStdin sent input preview', () => {
        const View = getToolResultViewComponent('CodexWriteStdin')

        renderWithProviders(
            <View
                block={makeToolBlock(
                    'CodexWriteStdin',
                    { output: 'polled output' },
                    { session_id: 7, chars: 'ls\n' }
                )}
                metadata={null}
            />
        )

        expect(screen.getByText(/Sent:/)).toBeInTheDocument()
        expect(screen.getByText(/ls/)).toBeInTheDocument()
    })

    it('renders CodexSpawnAgent result metadata', () => {
        const View = getToolResultViewComponent('CodexSpawnAgent')

        renderWithProviders(
            <View
                block={makeToolBlock(
                    'CodexSpawnAgent',
                    { agent_id: 'agent-1', nickname: 'Pauli' },
                    { agent_type: 'default', model: 'gpt-5.4-mini', message: 'Search GitHub trending' }
                )}
                metadata={null}
            />
        )

        expect(screen.getByText('Agent ID: agent-1')).toBeInTheDocument()
        expect(screen.getByText('Nickname: Pauli')).toBeInTheDocument()
        expect(screen.getByText('Prompt: Search GitHub trending')).toBeInTheDocument()
    })

    it('renders CodexCloseAgent structured status instead of no output placeholder', () => {
        const View = getToolResultViewComponent('CodexCloseAgent')

        renderWithProviders(
            <View
                block={makeToolBlock(
                    'CodexCloseAgent',
                    { status: 'closed' },
                    { target: 'agent-9' }
                )}
                metadata={null}
            />
        )

        expect(screen.getByText('Target: agent-9')).toBeInTheDocument()
        expect(screen.queryByText('(no output)')).not.toBeInTheDocument()
        expect(screen.getAllByText(/closed/).length).toBeGreaterThan(0)
    })

    it('renders CodexSendInput structured ack instead of no output placeholder', () => {
        const View = getToolResultViewComponent('CodexSendInput')

        renderWithProviders(
            <View
                block={makeToolBlock(
                    'CodexSendInput',
                    { ok: true },
                    { target: 'agent-4', message: 'continue' }
                )}
                metadata={null}
            />
        )

        expect(screen.getByText('Target: agent-4')).toBeInTheDocument()
        expect(screen.getByText('Message: continue')).toBeInTheDocument()
        expect(screen.queryByText('(no output)')).not.toBeInTheDocument()
        expect(screen.getAllByText(/true/).length).toBeGreaterThan(0)
    })

    it('renders CodexWaitAgent structured status map instead of no output placeholder', () => {
        const View = getToolResultViewComponent('CodexWaitAgent')

        renderWithProviders(
            <View
                block={makeToolBlock(
                    'CodexWaitAgent',
                    {
                        statuses: {
                            'agent-1': 'completed',
                            'agent-2': 'running'
                        }
                    },
                    { targets: ['agent-1', 'agent-2'], timeout_ms: 30000 }
                )}
                metadata={null}
            />
        )

        expect(screen.getByText('Targets: agent-1, agent-2')).toBeInTheDocument()
        expect(screen.queryByText('(no output)')).not.toBeInTheDocument()
        expect(screen.getAllByText(/completed/).length).toBeGreaterThan(0)
        expect(screen.getAllByText(/running/).length).toBeGreaterThan(0)
    })

    it('renders CodexWaitAgent target and timeout details', () => {
        const View = getToolResultViewComponent('CodexWaitAgent')

        renderWithProviders(
            <View
                block={makeToolBlock(
                    'CodexWaitAgent',
                    { status: 'completed', text: 'agent finished' },
                    { targets: ['agent-1'], timeout_ms: 30000 }
                )}
                metadata={null}
            />
        )

        expect(screen.getByText('Targets: agent-1')).toBeInTheDocument()
        expect(screen.getByText('Timeout: 30000')).toBeInTheDocument()
        expect(screen.getByText('agent finished')).toBeInTheDocument()
    })

    it('renders CodexSendInput target and message preview', () => {
        const View = getToolResultViewComponent('CodexSendInput')

        renderWithProviders(
            <View
                block={makeToolBlock(
                    'CodexSendInput',
                    { message: 'delivered' },
                    { target: 'agent-1', message: 'continue with tests', interrupt: true }
                )}
                metadata={null}
            />
        )

        expect(screen.getByText(/Target: agent-1/)).toBeInTheDocument()
        expect(screen.getByText(/continue with tests/)).toBeInTheDocument()
        expect(screen.getByText(/Interrupt/)).toBeInTheDocument()
    })

    it('renders CodexCloseAgent target details', () => {
        const View = getToolResultViewComponent('CodexCloseAgent')

        renderWithProviders(
            <View
                block={makeToolBlock(
                    'CodexCloseAgent',
                    { status: 'closed' },
                    { target: 'agent-1' }
                )}
                metadata={null}
            />
        )

        expect(screen.getByText('Target: agent-1')).toBeInTheDocument()
        expect(screen.getAllByText(/closed/).length).toBeGreaterThan(0)
    })
})
