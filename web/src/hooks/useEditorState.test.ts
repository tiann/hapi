import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useEditorState } from './useEditorState'

describe('useEditorState', () => {
    it('initializes machine and project from arguments', () => {
        const { result } = renderHook(() => useEditorState('machine-1', '/repo'))

        expect(result.current.machineId).toBe('machine-1')
        expect(result.current.projectPath).toBe('/repo')
        expect(result.current.tabs).toEqual([])
        expect(result.current.activeTabId).toBeNull()
    })

    it('opens a file tab once and activates the existing tab on duplicate opens', () => {
        const { result } = renderHook(() => useEditorState())

        act(() => {
            result.current.openFile('/repo/src/App.tsx')
        })
        const firstTabId = result.current.tabs[0].id

        expect(result.current.tabs).toEqual([
            expect.objectContaining({
                id: firstTabId,
                type: 'file',
                path: '/repo/src/App.tsx',
                label: 'App.tsx'
            })
        ])
        expect(result.current.activeTabId).toBe(firstTabId)

        act(() => {
            result.current.openFile('/repo/src/Other.ts')
            result.current.openFile('/repo/src/App.tsx')
        })

        expect(result.current.tabs).toHaveLength(2)
        expect(result.current.activeTabId).toBe(firstTabId)
    })

    it('opens terminal tabs with shell labels and activates the new tab', () => {
        const { result } = renderHook(() => useEditorState())

        act(() => {
            result.current.openTerminal()
            result.current.openTerminal('zsh')
        })

        expect(result.current.tabs).toEqual([
            expect.objectContaining({ type: 'terminal', label: 'Terminal: bash', shell: 'bash' }),
            expect.objectContaining({ type: 'terminal', label: 'Terminal: zsh (2)', shell: 'zsh' })
        ])
        expect(result.current.activeTabId).toBe(result.current.tabs[1].id)
    })

    it('chooses a neighboring active tab when closing the active tab', () => {
        const { result } = renderHook(() => useEditorState())

        act(() => {
            result.current.openFile('/repo/a.ts')
            result.current.openFile('/repo/b.ts')
            result.current.openFile('/repo/c.ts')
        })
        const [, b, c] = result.current.tabs

        act(() => {
            result.current.setActiveTabId(b.id)
            result.current.closeTab(b.id)
        })

        expect(result.current.tabs.map((tab) => tab.label)).toEqual(['a.ts', 'c.ts'])
        expect(result.current.activeTabId).toBe(c.id)
    })

    it('clears tabs and project when selecting a different machine', () => {
        const { result } = renderHook(() => useEditorState('machine-1', '/repo'))

        act(() => {
            result.current.openFile('/repo/a.ts')
            result.current.showContextMenu('/repo/a.ts', 10, 20)
            result.current.selectMachine('machine-2')
        })

        expect(result.current.machineId).toBe('machine-2')
        expect(result.current.projectPath).toBeNull()
        expect(result.current.tabs).toEqual([])
        expect(result.current.activeTabId).toBeNull()
        expect(result.current.contextMenuFile).toBe('/repo/a.ts')
        expect(result.current.contextMenuPosition).toEqual({ x: 10, y: 20 })
    })

    it('shows and hides context menu state', () => {
        const { result } = renderHook(() => useEditorState())

        act(() => {
            result.current.showContextMenu('/repo/file.ts', 100, 200)
        })

        expect(result.current.contextMenuFile).toBe('/repo/file.ts')
        expect(result.current.contextMenuPosition).toEqual({ x: 100, y: 200 })

        act(() => {
            result.current.hideContextMenu()
        })

        expect(result.current.contextMenuFile).toBeNull()
        expect(result.current.contextMenuPosition).toBeNull()
    })

    it('uses stable tab id shape', () => {
        vi.spyOn(Date, 'now').mockReturnValue(12345)
        vi.spyOn(Math, 'random').mockReturnValue(0.5)
        const { result } = renderHook(() => useEditorState())

        act(() => {
            result.current.openFile('/repo/file.ts')
        })

        expect(result.current.tabs[0].id).toMatch(/^tab_12345_[a-z0-9]+$/)
        vi.restoreAllMocks()
    })
})
