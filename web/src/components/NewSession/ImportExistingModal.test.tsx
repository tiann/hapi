import { useState } from 'react'
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

    it('shows imported-session actions for Codex by default', () => {
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
        expect(useImportableSessionsMock).toHaveBeenCalledWith(expect.anything(), 'codex', true)
        expect(useImportableSessionActionsMock).toHaveBeenCalledWith(expect.anything(), 'codex')
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

    it('switches to the Claude tab and loads Claude sessions with the same action model', () => {
        const refreshSession = vi.fn()
        const onOpenSession = vi.fn()

        useImportableSessionsMock.mockImplementation((_api: unknown, agent: 'codex' | 'claude') => ({
            sessions: agent === 'claude'
                ? [{
                    agent: 'claude',
                    externalSessionId: 'claude-external-1',
                    cwd: '/tmp/claude-project',
                    timestamp: 321,
                    transcriptPath: '/tmp/claude-project/session.jsonl',
                    previewTitle: 'Claude imported title',
                    previewPrompt: 'Claude prompt preview',
                    alreadyImported: true,
                    importedHapiSessionId: 'hapi-claude-1',
                }]
                : [],
            isLoading: false,
            error: null,
            refetch: vi.fn(),
        }))
        useImportableSessionActionsMock.mockImplementation((_api: unknown, agent: 'codex' | 'claude') => ({
            importSession: vi.fn(),
            refreshSession: agent === 'claude' ? refreshSession : vi.fn(),
            importingSessionId: null,
            refreshingSessionId: null,
            error: null,
        }))

        renderModal({ onOpenSession })

        fireEvent.click(screen.getByRole('button', { name: 'Claude' }))

        expect(useImportableSessionsMock).toHaveBeenLastCalledWith(expect.anything(), 'claude', true)
        expect(useImportableSessionActionsMock).toHaveBeenLastCalledWith(expect.anything(), 'claude')
        expect(screen.getByRole('button', { name: 'Open in HAPI' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Refresh from source' })).toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: 'Open in HAPI' }))
        expect(onOpenSession).toHaveBeenCalledWith('hapi-claude-1')

        fireEvent.click(screen.getByRole('button', { name: 'Refresh from source' }))
        expect(refreshSession).toHaveBeenCalledWith('claude-external-1')
    })

    it('does not leak Codex action state into the Claude tab', () => {
        useImportableSessionsMock.mockImplementation((_api: unknown, agent: 'codex' | 'claude') => ({
            sessions: [{
                agent,
                externalSessionId: `${agent}-external-1`,
                cwd: `/tmp/${agent}-project`,
                timestamp: 111,
                transcriptPath: `/tmp/${agent}-project/session.jsonl`,
                previewTitle: `${agent} title`,
                previewPrompt: `${agent} prompt`,
                alreadyImported: false,
                importedHapiSessionId: null,
            }],
            isLoading: false,
            error: null,
            refetch: vi.fn(),
        }))
        useImportableSessionActionsMock.mockImplementation((_api: unknown, agent: 'codex' | 'claude') => {
            const [error] = useState<string | null>(agent === 'codex' ? 'Codex failed' : null)
            return {
                importSession: vi.fn(),
                refreshSession: vi.fn(),
                importingSessionId: null,
                refreshingSessionId: null,
                error,
            }
        })

        renderModal()

        expect(screen.getByText('Codex failed')).toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: 'Claude' }))

        expect(screen.queryByText('Codex failed')).not.toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Import into HAPI' })).toBeInTheDocument()
    })

    it('imports a Claude session and opens it immediately after success', async () => {
        const onOpenSession = vi.fn()
        const importSession = vi.fn().mockResolvedValue({
            type: 'success',
            sessionId: 'hapi-claude-imported-1',
        })

        useImportableSessionsMock.mockImplementation((_api: unknown, agent: 'codex' | 'claude') => ({
            sessions: agent === 'claude'
                ? [{
                    agent: 'claude',
                    externalSessionId: 'claude-external-2',
                    cwd: '/tmp/claude-project-2',
                    timestamp: 654,
                    transcriptPath: '/tmp/claude-project-2/session.jsonl',
                    previewTitle: 'Claude import later',
                    previewPrompt: 'Claude prompt preview',
                    alreadyImported: false,
                    importedHapiSessionId: null,
                }]
                : [],
            isLoading: false,
            error: null,
            refetch: vi.fn(),
        }))
        useImportableSessionActionsMock.mockImplementation((_api: unknown, agent: 'codex' | 'claude') => ({
            importSession: agent === 'claude' ? importSession : vi.fn(),
            refreshSession: vi.fn(),
            importingSessionId: null,
            refreshingSessionId: null,
            error: null,
        }))

        renderModal({ onOpenSession })
        fireEvent.click(screen.getByRole('button', { name: 'Claude' }))
        fireEvent.click(screen.getByRole('button', { name: 'Import into HAPI' }))

        expect(importSession).toHaveBeenCalledWith('claude-external-2')

        await vi.waitFor(() => {
            expect(onOpenSession).toHaveBeenCalledWith('hapi-claude-imported-1')
        })
    })
})
