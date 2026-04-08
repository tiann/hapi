import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import { NewSession } from './index'

const spawnSessionMock = vi.fn()
const hapticNotificationMock = vi.fn()

vi.mock('@/hooks/usePlatform', () => ({
    usePlatform: () => ({
        haptic: {
            notification: hapticNotificationMock
        }
    })
}))

vi.mock('@/hooks/mutations/useSpawnSession', () => ({
    useSpawnSession: () => ({
        spawnSession: spawnSessionMock,
        isPending: false,
        error: null
    })
}))

vi.mock('@/hooks/queries/useSessions', () => ({
    useSessions: () => ({ sessions: [] })
}))

vi.mock('@/hooks/useActiveSuggestions', () => ({
    useActiveSuggestions: () => [[], -1, vi.fn(), vi.fn(), vi.fn()]
}))

vi.mock('@/hooks/useDirectorySuggestions', () => ({
    useDirectorySuggestions: () => []
}))

vi.mock('@/hooks/useRecentPaths', () => ({
    useRecentPaths: () => ({
        getRecentPaths: () => [],
        addRecentPath: vi.fn(),
        getLastUsedMachineId: () => null,
        setLastUsedMachineId: vi.fn()
    })
}))

vi.mock('@/hooks/queries/useMachineSessionProfiles', () => ({
    useMachineSessionProfiles: () => ({
        profiles: [
            {
                id: 'ice',
                label: 'Ice',
                agent: 'codex',
                defaults: {
                    model: 'gpt-5.4',
                    modelReasoningEffort: 'high',
                    permissionMode: 'safe-yolo',
                    collaborationMode: 'plan',
                    sessionType: 'worktree'
                }
            }
        ],
        defaults: {
            codexProfileId: 'ice'
        },
        isLoading: false,
        error: null,
        refetch: vi.fn()
    })
}))

vi.mock('@/hooks/useMachinePathsExists', () => ({
    useMachinePathsExists: () => ({
        pathExistence: {
            '/tmp/project': true
        },
        checkPathsExists: async (paths: string[]) => Object.fromEntries(paths.map((path) => [path, path === '/tmp/project']))
    })
}))

vi.mock('../../utils/formatRunnerSpawnError', () => ({
    formatRunnerSpawnError: () => null
}))

function renderNewSession() {
    return render(
        <I18nProvider>
            <NewSession
                api={{} as never}
                machines={[
                    {
                        id: 'machine-1',
                        active: true,
                        metadata: {
                            host: 'localhost',
                            platform: 'darwin',
                            happyCliVersion: '0.1.0'
                        },
                        runnerState: null
                    }
                ]}
                onSuccess={vi.fn()}
                onCancel={vi.fn()}
            />
        </I18nProvider>
    )
}

describe('NewSession Codex profiles', () => {
    beforeEach(() => {
        spawnSessionMock.mockReset()
        hapticNotificationMock.mockReset()
        localStorage.clear()
        localStorage.setItem('hapi:newSession:agent', 'codex')
    })

    it('preselects the default Codex profile and applies its defaults', async () => {
        renderNewSession()

        await waitFor(() => {
            expect(screen.getByDisplayValue('Ice')).toBeInTheDocument()
        })

        expect(screen.getByDisplayValue('GPT-5.4')).toBeInTheDocument()
        expect(screen.getByDisplayValue('High')).toBeInTheDocument()
        expect(screen.getByDisplayValue('Safe YOLO')).toBeInTheDocument()
    })

    it('resets Codex launch fields to base defaults when no profile is selected', async () => {
        renderNewSession()

        await waitFor(() => {
            expect(screen.getByRole('combobox', { name: 'Profile' })).toHaveValue('ice')
        })

        fireEvent.change(screen.getByRole('combobox', { name: 'Profile' }), {
            target: { value: '' }
        })

        await waitFor(() => {
            expect(screen.getByLabelText('Model')).toHaveValue('auto')
        })

        expect(screen.getByLabelText('Reasoning effort')).toHaveValue('default')
        expect(screen.getByRole('combobox', { name: 'Permission mode' })).toHaveValue('default')
    })

    it('sends profileId, permissionMode, and collaborationMode in the spawn payload', async () => {
        spawnSessionMock.mockResolvedValue({ type: 'success', sessionId: 'session-1' })
        renderNewSession()

        fireEvent.change(screen.getByLabelText('Directory'), {
            target: { value: '/tmp/project' }
        })
        fireEvent.click(screen.getByRole('button', { name: 'Create' }))

        await waitFor(() => {
            expect(spawnSessionMock).toHaveBeenCalledWith(expect.objectContaining({
                profileId: 'ice',
                permissionMode: 'safe-yolo',
                collaborationMode: 'plan'
            }))
        })
    })
})
