import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider } from '@/lib/toast-context'
import { DEFAULT_DIRECTORY_SORT } from '@/lib/directory-sort'
import { DirectoryTree } from '@/components/SessionFiles/DirectoryTree'

const mocks = vi.hoisted(() => ({
    entries: [
        { name: 'README.md', type: 'file' as const, size: 12, modified: 1_784_175_060_000 },
        { name: 'src', type: 'directory' as const },
    ] as Array<{ name: string; type: 'file' | 'directory'; size?: number; modified?: number }>,
}))

vi.mock('@/hooks/queries/useSessionDirectory', () => ({
    useSessionDirectory: () => ({
        entries: mocks.entries,
        error: null,
        isLoading: false,
        refetch: vi.fn(),
    }),
}))

function renderTree(handlers: {
    onOpenFile?: () => void
    onRequestFileMenu?: (path: string, point: { x: number; y: number }) => void
} = {}) {
    const onOpenFile = handlers.onOpenFile ?? vi.fn()
    const onRequestFileMenu = handlers.onRequestFileMenu ?? vi.fn()

    render(
        <I18nProvider>
            <ToastProvider>
                <DirectoryTree
                    api={{} as never}
                    sessionId="session-1"
                    rootLabel="project"
                    onOpenFile={onOpenFile}
                    onRequestFileMenu={onRequestFileMenu}
                    sort={DEFAULT_DIRECTORY_SORT}
                />
            </ToastProvider>
        </I18nProvider>
    )

    return { onOpenFile, onRequestFileMenu }
}

/** The file name button (a directory row's download button also mentions the name in its aria-label). */
function fileRow(): HTMLButtonElement {
    return screen.getByText('README.md').closest('button') as HTMLButtonElement
}

beforeEach(() => {
    vi.clearAllMocks()
    window.sessionStorage.clear()
})

afterEach(() => cleanup())

describe('DirectoryTree file context menu', () => {
    it('requests the menu on right-click with the entry path and pointer', () => {
        const { onRequestFileMenu } = renderTree()

        fireEvent.contextMenu(fileRow(), { clientX: 321, clientY: 123 })

        expect(onRequestFileMenu).toHaveBeenCalledWith('README.md', { x: 321, y: 123 })
    })

    it('requests the menu on touch long-press and does not open the file on release', () => {
        vi.useFakeTimers()
        try {
            const { onOpenFile, onRequestFileMenu } = renderTree()

            fireEvent.touchStart(fileRow(), { touches: [{ clientX: 44, clientY: 55 }] })
            act(() => {
                vi.advanceTimersByTime(600)
            })

            expect(onRequestFileMenu).toHaveBeenCalledWith('README.md', { x: 44, y: 55 })
            expect(onOpenFile).not.toHaveBeenCalled()

            fireEvent.touchEnd(fileRow(), { changedTouches: [{ clientX: 44, clientY: 55 }] })
            expect(onOpenFile).not.toHaveBeenCalled()
        } finally {
            vi.useRealTimers()
        }
    })
})
