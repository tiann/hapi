import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '@/types/api'
import { SessionHeader } from './SessionHeader'

const navigateMock = vi.fn()

vi.mock('@tanstack/react-router', () => ({
    useNavigate: () => navigateMock
}))

vi.mock('@/hooks/useTelegram', () => ({
    isTelegramApp: () => false
}))

vi.mock('@/hooks/mutations/useSessionActions', () => ({
    useSessionActions: () => ({
        archiveSession: vi.fn(),
        renameSession: vi.fn(),
        deleteSession: vi.fn(),
        isPending: false
    })
}))

vi.mock('@/components/SessionActionMenu', () => ({
    SessionActionMenu: () => null
}))

vi.mock('@/components/RenameSessionDialog', () => ({
    RenameSessionDialog: () => null
}))

vi.mock('@/components/ui/ConfirmDialog', () => ({
    ConfirmDialog: () => null
}))

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({ t: (key: string) => key })
}))

function makeSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 'session-1',
        namespace: 'default',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: { path: '/repo', host: 'host', machineId: 'machine-1', flavor: 'codex' },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 1,
        backgroundTaskCount: 0,
        todos: undefined,
        teamState: undefined,
        model: null,
        modelReasoningEffort: null,
        effort: null,
        permissionMode: 'default',
        collaborationMode: undefined,
        ...overrides
    }
}

describe('SessionHeader editor entry point', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    afterEach(() => {
        cleanup()
    })

    it('opens the session project in editor mode', () => {
        render(<SessionHeader session={makeSession()} onBack={vi.fn()} api={null} />)

        fireEvent.click(screen.getByRole('button', { name: 'Open in Editor' }))

        expect(navigateMock).toHaveBeenCalledWith({
            to: '/editor',
            search: { machine: 'machine-1', project: '/repo' }
        })
    })

    it('hides the editor action when machine or path is missing', () => {
        render(<SessionHeader session={makeSession({ metadata: { path: '/repo', host: 'host' } })} onBack={vi.fn()} api={null} />)

        expect(screen.queryByRole('button', { name: 'Open in Editor' })).not.toBeInTheDocument()
    })
})
