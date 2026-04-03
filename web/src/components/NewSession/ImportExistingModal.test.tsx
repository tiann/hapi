import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import { ImportExistingModal } from './ImportExistingModal'

const useImportableSessionsMock = vi.fn()
const useImportableSessionActionsMock = vi.fn()

vi.mock('@/hooks/queries/useImportableSessions', () => ({
    useImportableSessions: (...args: unknown[]) => useImportableSessionsMock(...args),
}))

vi.mock('@/hooks/mutations/useImportableSessionActions', () => ({
    useImportableSessionActions: (...args: unknown[]) => useImportableSessionActionsMock(...args),
}))

function renderModal(props?: { onOpenSession?: (sessionId: string) => void }) {
    return render(
        <I18nProvider>
            <ImportExistingModal
                api={{} as never}
                open
                onOpenChange={vi.fn()}
                onOpenSession={props?.onOpenSession ?? vi.fn()}
            />
        </I18nProvider>
    )
}

describe('ImportExistingModal', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        useImportableSessionsMock.mockReturnValue({
            sessions: [],
            isLoading: false,
            error: null,
            refetch: vi.fn(),
        })
        useImportableSessionActionsMock.mockReturnValue({
            importSession: vi.fn(),
            refreshSession: vi.fn(),
            importingSessionId: null,
            refreshingSessionId: null,
            error: null,
        })
    })

    it('shows imported-session actions and disables the Claude tab', () => {
        useImportableSessionsMock.mockReturnValue({
            sessions: [{
                agent: 'codex',
                externalSessionId: 'external-1',
                cwd: '/tmp/project',
                timestamp: 123,
                transcriptPath: '/tmp/project/session.jsonl',
                previewTitle: 'Imported title',
                previewPrompt: 'Prompt preview',
                alreadyImported: true,
                importedHapiSessionId: 'hapi-123',
            }],
            isLoading: false,
            error: null,
            refetch: vi.fn(),
        })

        renderModal()

        expect(screen.getByRole('button', { name: 'Open in HAPI' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Refresh from source' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Claude' })).toBeDisabled()
    })

    it('shows import action for not-yet-imported sessions', () => {
        const importSession = vi.fn().mockResolvedValue({
            type: 'success',
            sessionId: 'hapi-imported-0',
        })
        useImportableSessionsMock.mockReturnValue({
            sessions: [{
                agent: 'codex',
                externalSessionId: 'external-2',
                cwd: '/tmp/project-2',
                timestamp: 456,
                transcriptPath: '/tmp/project-2/session.jsonl',
                previewTitle: null,
                previewPrompt: 'Prompt preview',
                alreadyImported: false,
                importedHapiSessionId: null,
            }],
            isLoading: false,
            error: null,
            refetch: vi.fn(),
        })
        useImportableSessionActionsMock.mockReturnValue({
            importSession,
            refreshSession: vi.fn(),
            importingSessionId: null,
            refreshingSessionId: null,
            error: null,
        })

        renderModal()
        fireEvent.click(screen.getByRole('button', { name: 'Import into HAPI' }))

        expect(importSession).toHaveBeenCalledWith('external-2')
    })

    it('opens the imported HAPI session immediately after import succeeds', async () => {
        const onOpenSession = vi.fn()
        const importSession = vi.fn().mockResolvedValue({
            type: 'success',
            sessionId: 'hapi-imported-1',
        })

        useImportableSessionsMock.mockReturnValue({
            sessions: [{
                agent: 'codex',
                externalSessionId: 'external-3',
                cwd: '/tmp/project-3',
                timestamp: 789,
                transcriptPath: '/tmp/project-3/session.jsonl',
                previewTitle: 'Imported later',
                previewPrompt: 'Prompt preview',
                alreadyImported: false,
                importedHapiSessionId: null,
            }],
            isLoading: false,
            error: null,
            refetch: vi.fn(),
        })
        useImportableSessionActionsMock.mockReturnValue({
            importSession,
            refreshSession: vi.fn(),
            importingSessionId: null,
            refreshingSessionId: null,
            error: null,
        })

        renderModal({ onOpenSession })
        fireEvent.click(screen.getByRole('button', { name: 'Import into HAPI' }))

        await vi.waitFor(() => {
            expect(onOpenSession).toHaveBeenCalledWith('hapi-imported-1')
        })
    })
})
