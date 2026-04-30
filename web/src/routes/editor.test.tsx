import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import EditorPage from './editor'

const editorLayoutMock = vi.fn()
const api = {} as ApiClient

vi.mock('@tanstack/react-router', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@tanstack/react-router')>()
    return {
        ...actual,
        useSearch: () => ({ machine: 'machine-1', project: '/repo' })
    }
})

vi.mock('@/lib/app-context', () => ({
    useAppContext: () => ({ api })
}))


vi.mock('@/routes/sessions/terminal', () => ({
    default: () => <div />
}))

vi.mock('@/components/Terminal/TerminalView', () => ({
    TerminalView: () => <div />
}))

vi.mock('@/components/editor/EditorLayout', () => ({
    EditorLayout: (props: unknown) => {
        editorLayoutMock(props)
        return <div data-testid="editor-layout" />
    }
}))

describe('EditorPage', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    afterEach(() => {
        cleanup()
    })

    it('passes search params to EditorLayout', () => {
        render(<EditorPage />)

        expect(editorLayoutMock).toHaveBeenCalledWith({
            api,
            initialMachineId: 'machine-1',
            initialProjectPath: '/repo'
        })
    })

    it('is registered in the router', async () => {
        const { createAppRouter } = await import('@/router')
        const router = createAppRouter() as unknown as { routesByPath: Record<string, unknown> }

        expect(router.routesByPath['/editor']).toBeTruthy()
    })
})
