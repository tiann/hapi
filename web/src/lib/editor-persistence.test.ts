import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('editor persistence', () => {
    beforeEach(() => {
        sessionStorage.clear()
        localStorage.clear()
        vi.resetModules()
    })

    it('stores editor state in the current page instance only', async () => {
        const firstModule = await import('./editor-persistence')

        firstModule.savePersistedEditorState({
            machineId: 'machine-1',
            projectPath: '/repo',
            tabs: [{ id: 'term-1', type: 'terminal', label: 'Terminal: bash', machineId: 'machine-1', cwd: '/repo' }],
            activeTabId: 'term-1',
            activeSessionId: null,
            isTerminalCollapsed: false
        })

        expect(firstModule.loadPersistedEditorState()?.projectPath).toBe('/repo')

        vi.resetModules()
        const nextPageModule = await import('./editor-persistence')

        expect(nextPageModule.loadPersistedEditorState()).toBeNull()
    })

    it('clears editor state for the current tab', async () => {
        const persistence = await import('./editor-persistence')

        persistence.savePersistedEditorState({
            machineId: 'machine-1',
            projectPath: '/repo',
            tabs: [],
            activeTabId: null,
            activeSessionId: null,
            isTerminalCollapsed: true
        })
        persistence.clearPersistedEditorState()

        expect(persistence.loadPersistedEditorState()).toBeNull()
    })
})
