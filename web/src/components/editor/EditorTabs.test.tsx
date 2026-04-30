import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { EditorTab } from '@/hooks/useEditorState'
import { EditorTabs } from './EditorTabs'

const cmMocks = vi.hoisted(() => ({
    editorViews: [] as Array<{ doc: string; destroyed: boolean; dispatch: ReturnType<typeof vi.fn> }>,
    EditorView: vi.fn(function EditorView(this: { state: { doc: { toString: () => string; length: number } }; destroy: () => void; dispatch: ReturnType<typeof vi.fn> }, config: { doc?: string; parent?: Element }) {
        const view = {
            doc: config.doc ?? '',
            destroyed: false,
            dispatch: vi.fn((payload: { changes?: { insert?: string } }) => {
                view.doc = payload.changes?.insert ?? view.doc
            })
        }
        cmMocks.editorViews.push(view)
        if (config.parent) {
            const marker = document.createElement('div')
            marker.dataset.testid = 'codemirror-view'
            config.parent.appendChild(marker)
        }
        this.state = {
            doc: {
                toString: () => view.doc,
                get length() {
                    return view.doc.length
                }
            }
        }
        this.dispatch = view.dispatch
        this.destroy = () => {
            view.destroyed = true
        }
    }),
    language: vi.fn((..._args: unknown[]) => 'language-extension')
}))

vi.mock('codemirror', () => {
    const editorView = cmMocks.EditorView as typeof cmMocks.EditorView & {
        editable: { of: ReturnType<typeof vi.fn> }
        theme: ReturnType<typeof vi.fn>
    }
    editorView.editable = { of: vi.fn(() => 'editable-extension') }
    editorView.theme = vi.fn(() => 'editor-theme')
    return {
        basicSetup: 'basic-setup',
        EditorView: cmMocks.EditorView
    }
})

vi.mock('@codemirror/theme-one-dark', () => ({ oneDark: 'one-dark' }))
vi.mock('@codemirror/lang-javascript', () => ({ javascript: (...args: unknown[]) => cmMocks.language('javascript', ...args) }))
vi.mock('@codemirror/lang-json', () => ({ json: (...args: unknown[]) => cmMocks.language('json', ...args) }))
vi.mock('@codemirror/lang-css', () => ({ css: (...args: unknown[]) => cmMocks.language('css', ...args) }))
vi.mock('@codemirror/lang-html', () => ({ html: (...args: unknown[]) => cmMocks.language('html', ...args) }))
vi.mock('@codemirror/lang-markdown', () => ({ markdown: (...args: unknown[]) => cmMocks.language('markdown', ...args) }))
vi.mock('@codemirror/lang-python', () => ({ python: (...args: unknown[]) => cmMocks.language('python', ...args) }))
vi.mock('@codemirror/lang-rust', () => ({ rust: (...args: unknown[]) => cmMocks.language('rust', ...args) }))
vi.mock('@codemirror/lang-go', () => ({ go: (...args: unknown[]) => cmMocks.language('go', ...args) }))

const useEditorFileMock = vi.fn()
vi.mock('@/hooks/queries/useEditorFile', () => ({
    useEditorFile: (...args: unknown[]) => useEditorFileMock(...args)
}))

const tabs: EditorTab[] = [
    { id: 'tab-file', type: 'file', path: '/repo/src/App.tsx', label: 'App.tsx' },
    { id: 'tab-terminal', type: 'terminal', label: 'Terminal: bash', shell: 'bash' }
]

describe('EditorTabs', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        cmMocks.editorViews.length = 0
        useEditorFileMock.mockReturnValue({ content: 'console.log("hi")', error: null, isLoading: false, refetch: vi.fn() })
    })

    afterEach(() => {
        cleanup()
    })

    it('shows an empty state when no tab is active', () => {
        render(
            <EditorTabs
                api={null}
                machineId={null}
                tabs={[]}
                activeTabId={null}
                onSelectTab={vi.fn()}
                onCloseTab={vi.fn()}
                onOpenTerminal={vi.fn()}
            />
        )

        expect(screen.getByText('Open a file from the explorer')).toBeInTheDocument()
    })

    it('renders tabs and emits select, close, and new terminal actions', () => {
        const onSelectTab = vi.fn()
        const onCloseTab = vi.fn()
        const onOpenTerminal = vi.fn()

        render(
            <EditorTabs
                api={{} as ApiClient}
                machineId="machine-1"
                tabs={tabs}
                activeTabId="tab-file"
                onSelectTab={onSelectTab}
                onCloseTab={onCloseTab}
                onOpenTerminal={onOpenTerminal}
            />
        )

        fireEvent.click(screen.getByRole('button', { name: 'Select tab Terminal: bash' }))
        expect(onSelectTab).toHaveBeenCalledWith('tab-terminal')

        fireEvent.click(screen.getByRole('button', { name: 'Close tab App.tsx' }))
        expect(onCloseTab).toHaveBeenCalledWith('tab-file')
        expect(onSelectTab).not.toHaveBeenCalledWith('tab-file')

        fireEvent.click(screen.getByRole('button', { name: 'New Terminal' }))
        expect(onOpenTerminal).toHaveBeenCalled()
    })

    it('loads active file content into a read-only CodeMirror view', async () => {
        const api = {} as ApiClient

        render(
            <EditorTabs
                api={api}
                machineId="machine-1"
                tabs={tabs}
                activeTabId="tab-file"
                onSelectTab={vi.fn()}
                onCloseTab={vi.fn()}
                onOpenTerminal={vi.fn()}
            />
        )

        await waitFor(() => {
            expect(cmMocks.EditorView).toHaveBeenCalled()
        })
        expect(useEditorFileMock).toHaveBeenCalledWith(api, 'machine-1', '/repo/src/App.tsx')
        expect(cmMocks.editorViews[0].doc).toBe('console.log("hi")')
        expect(screen.getByTestId('codemirror-view')).toBeInTheDocument()
        expect(screen.getByText('TSX')).toBeInTheDocument()
        expect(cmMocks.language).toHaveBeenCalledWith('javascript', { jsx: true, typescript: true })
    })

    it('keeps the editor viewport constrained so CodeMirror owns scrolling', async () => {
        render(
            <EditorTabs
                api={{} as ApiClient}
                machineId="machine-1"
                tabs={tabs}
                activeTabId="tab-file"
                onSelectTab={vi.fn()}
                onCloseTab={vi.fn()}
                onOpenTerminal={vi.fn()}
            />
        )

        await waitFor(() => {
            expect(screen.getByTestId('editor-tabs-content')).toBeInTheDocument()
        })

        expect(screen.getByTestId('editor-tabs-root')).toHaveClass('overflow-hidden')
        expect(screen.getByTestId('editor-tabs-content')).toHaveClass('overflow-hidden')
        expect(screen.getByTestId('codemirror-host')).toHaveClass('h-full', 'min-h-0', 'overflow-hidden')
    })

    it('mounts CodeMirror when content arrives after the loading state', async () => {
        useEditorFileMock.mockReturnValueOnce({ content: null, error: null, isLoading: true, refetch: vi.fn() })
        const api = {} as ApiClient
        const { rerender } = render(
            <EditorTabs
                api={api}
                machineId="machine-1"
                tabs={tabs}
                activeTabId="tab-file"
                onSelectTab={vi.fn()}
                onCloseTab={vi.fn()}
                onOpenTerminal={vi.fn()}
            />
        )

        expect(screen.getByText('Loading...')).toBeInTheDocument()
        expect(cmMocks.EditorView).not.toHaveBeenCalled()

        rerender(
            <EditorTabs
                api={api}
                machineId="machine-1"
                tabs={tabs}
                activeTabId="tab-file"
                onSelectTab={vi.fn()}
                onCloseTab={vi.fn()}
                onOpenTerminal={vi.fn()}
            />
        )

        await waitFor(() => {
            expect(cmMocks.EditorView).toHaveBeenCalled()
        })
        expect(cmMocks.editorViews[0].doc).toBe('console.log("hi")')
        expect(screen.getByTestId('codemirror-view')).toBeInTheDocument()
    })

    it('shows file loading and error states instead of CodeMirror', () => {
        useEditorFileMock.mockReturnValueOnce({ content: null, error: null, isLoading: true, refetch: vi.fn() })
        const { rerender } = render(
            <EditorTabs
                api={{} as ApiClient}
                machineId="machine-1"
                tabs={tabs}
                activeTabId="tab-file"
                onSelectTab={vi.fn()}
                onCloseTab={vi.fn()}
                onOpenTerminal={vi.fn()}
            />
        )

        expect(screen.getByText('Loading...')).toBeInTheDocument()

        useEditorFileMock.mockReturnValueOnce({ content: null, error: 'Cannot read binary file', isLoading: false, refetch: vi.fn() })
        rerender(
            <EditorTabs
                api={{} as ApiClient}
                machineId="machine-1"
                tabs={tabs}
                activeTabId="tab-file"
                onSelectTab={vi.fn()}
                onCloseTab={vi.fn()}
                onOpenTerminal={vi.fn()}
            />
        )

        expect(screen.getByText('Cannot read binary file')).toBeInTheDocument()
    })

    it('shows terminal placeholder for terminal tabs', () => {
        render(
            <EditorTabs
                api={null}
                machineId="machine-1"
                tabs={tabs}
                activeTabId="tab-terminal"
                onSelectTab={vi.fn()}
                onCloseTab={vi.fn()}
                onOpenTerminal={vi.fn()}
            />
        )

        expect(screen.getByText('Terminal panel below')).toBeInTheDocument()
        expect(useEditorFileMock).not.toHaveBeenCalled()
    })
})
