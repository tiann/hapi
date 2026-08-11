import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DirectoryTree } from '@/components/SessionFiles/DirectoryTree'
import { ToastProvider } from '@/lib/toast-context'
import { I18nProvider } from '@/lib/i18n-context'
import { DEFAULT_DIRECTORY_SORT } from '@/lib/directory-sort'

vi.mock('@/hooks/queries/useSessionDirectory', () => ({
    useSessionDirectory: (_api: unknown, _sessionId: string, path: string) => ({
        entries: path === ''
            ? [
                { name: 'src', type: 'directory' },
                { name: 'README.md', type: 'file' },
            ]
            : path === 'src'
                ? [{ name: 'index.ts', type: 'file' }]
                : [],
        error: null,
        isLoading: false,
        refetch: vi.fn(),
    }),
}))

function renderTree(sessionId = 'session-1') {
    return render(
        <I18nProvider>
            <ToastProvider>
                <DirectoryTree
                    api={{} as never}
                    sessionId={sessionId}
                    rootLabel="/workspace/project"
                    onOpenFile={vi.fn()}
                    sort={DEFAULT_DIRECTORY_SORT}
                />
            </ToastProvider>
        </I18nProvider>
    )
}

describe('DirectoryTree expanded folders', () => {
    beforeEach(() => {
        localStorage.clear()
        sessionStorage.clear()
    })

    afterEach(() => cleanup())

    it('restores expanded folders after the file manager remounts', () => {
        const view = renderTree()
        fireEvent.click(screen.getByRole('button', { name: 'src' }))

        expect(screen.getByRole('button', { name: 'index.ts' })).toBeInTheDocument()
        expect(localStorage.getItem('hapi-dir-expanded-v2-session-1')).toBe(JSON.stringify(['', 'src']))

        view.unmount()
        renderTree()

        expect(screen.getByRole('button', { name: 'index.ts' })).toBeInTheDocument()
    })

    it('migrates the legacy sessionStorage folder state to localStorage', () => {
        sessionStorage.setItem('hapi-dir-expanded-session-1', JSON.stringify(['', 'src']))

        renderTree()

        expect(screen.getByRole('button', { name: 'index.ts' })).toBeInTheDocument()
        expect(localStorage.getItem('hapi-dir-expanded-v2-session-1')).toBe(JSON.stringify(['', 'src']))
        expect(sessionStorage.getItem('hapi-dir-expanded-session-1')).toBeNull()
    })

    it('prefers the session fallback after localStorage writes fail', () => {
        localStorage.setItem('hapi-dir-expanded-v2-session-1', JSON.stringify(['']))
        const originalSetItem = Storage.prototype.setItem
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function setItem(this: Storage, key, value) {
            if (this === localStorage && key === 'hapi-dir-expanded-v2-session-1') throw new Error('quota')
            return originalSetItem.call(this, key, value)
        })
        const sessionSetItem = vi.spyOn(sessionStorage, 'setItem')

        const view = renderTree()
        fireEvent.click(screen.getByRole('button', { name: 'src' }))

        expect(sessionSetItem).toHaveBeenLastCalledWith('hapi-dir-expanded-session-1', JSON.stringify(['', 'src']))

        view.unmount()
        renderTree()

        expect(screen.getByRole('button', { name: 'index.ts' })).toBeInTheDocument()
    })

    it('uses the session fallback when localStorage reads throw', () => {
        sessionStorage.setItem('hapi-dir-expanded-session-1', JSON.stringify(['', 'src']))
        const originalGetItem = Storage.prototype.getItem
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function getItem(this: Storage, key) {
            if (this === localStorage && key === 'hapi-dir-expanded-v2-session-1') throw new Error('unavailable')
            return originalGetItem.call(this, key)
        })

        renderTree()

        expect(screen.getByRole('button', { name: 'index.ts' })).toBeInTheDocument()
    })
})
