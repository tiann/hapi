import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import { ExitPlanModeFooter } from '@/components/ToolCard/ExitPlanModeFooter'

const haptic = {
    selection: vi.fn(),
    notification: vi.fn(),
    impact: vi.fn()
}

vi.mock('@/hooks/usePlatform', () => ({
    usePlatform: () => ({
        isTelegram: false,
        isTouch: false,
        haptic
    })
}))

function renderWithProviders(ui: React.ReactElement) {
    return render(
        <I18nProvider>
            {ui}
        </I18nProvider>
    )
}

function createTool() {
    return {
        id: 'tool-1',
        name: 'exit_plan_mode',
        state: 'pending' as const,
        input: { plan: 'Implement the approved plan' },
        createdAt: 1,
        startedAt: null,
        completedAt: null,
        description: null,
        permission: {
            id: 'request-1',
            status: 'pending' as const
        }
    }
}

describe('ExitPlanModeFooter', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        const localStorageMock = {
            getItem: vi.fn(() => 'en'),
            setItem: vi.fn(),
            removeItem: vi.fn()
        }
        Object.defineProperty(window, 'localStorage', { value: localStorageMock, configurable: true })
    })

    it('submits default permission mode when only implementation mode is selected', async () => {
        const api = {
            approvePermission: vi.fn(async () => {}),
            denyPermission: vi.fn(async () => {})
        }

        renderWithProviders(
            <ExitPlanModeFooter
                api={api as never}
                sessionId="session-1"
                tool={createTool() as never}
                disabled={false}
                onDone={vi.fn()}
            />
        )

        fireEvent.click(screen.getByText('Clear context'))
        fireEvent.click(screen.getByRole('button', { name: 'Start implementation' }))

        expect(api.approvePermission).toHaveBeenCalledWith('session-1', 'request-1', {
            mode: 'default',
            implementationMode: 'clear_context'
        })
    })

    it('submits independently selected permission mode and implementation mode', async () => {
        const api = {
            approvePermission: vi.fn(async () => {}),
            denyPermission: vi.fn(async () => {})
        }

        renderWithProviders(
            <ExitPlanModeFooter
                api={api as never}
                sessionId="session-1"
                tool={createTool() as never}
                disabled={false}
                onDone={vi.fn()}
            />
        )

        fireEvent.click(screen.getByText('Clear context'))
        fireEvent.click(screen.getByText('Accept edits'))
        fireEvent.click(screen.getByRole('button', { name: 'Start implementation' }))

        expect(api.approvePermission).toHaveBeenCalledWith('session-1', 'request-1', {
            mode: 'acceptEdits',
            implementationMode: 'clear_context'
        })
    })

    it('submits keep_context with YOLO permission mode', async () => {
        const api = {
            approvePermission: vi.fn(async () => {}),
            denyPermission: vi.fn(async () => {})
        }

        renderWithProviders(
            <ExitPlanModeFooter
                api={api as never}
                sessionId="session-1"
                tool={createTool() as never}
                disabled={false}
                onDone={vi.fn()}
            />
        )

        fireEvent.click(screen.getByText('Keep context'))
        fireEvent.click(screen.getByText('YOLO'))
        fireEvent.click(screen.getByRole('button', { name: 'Start implementation' }))

        expect(api.approvePermission).toHaveBeenCalledWith('session-1', 'request-1', {
            mode: 'bypassPermissions',
            implementationMode: 'keep_context'
        })
    })

    it('shows a validation error before submission when no option is selected', async () => {
        const api = {
            approvePermission: vi.fn(async () => {}),
            denyPermission: vi.fn(async () => {})
        }

        renderWithProviders(
            <ExitPlanModeFooter
                api={api as never}
                sessionId="session-1"
                tool={createTool() as never}
                disabled={false}
                onDone={vi.fn()}
            />
        )

        fireEvent.click(screen.getByRole('button', { name: 'Start implementation' }))

        expect(screen.getByText('Please choose how to start implementation.')).toBeInTheDocument()
        expect(api.approvePermission).not.toHaveBeenCalled()
    })

    it('can deny the request directly', async () => {
        const api = {
            approvePermission: vi.fn(async () => {}),
            denyPermission: vi.fn(async () => {})
        }

        renderWithProviders(
            <ExitPlanModeFooter
                api={api as never}
                sessionId="session-1"
                tool={createTool() as never}
                disabled={false}
                onDone={vi.fn()}
            />
        )

        fireEvent.click(screen.getByRole('button', { name: 'Deny' }))

        expect(api.denyPermission).toHaveBeenCalledWith('session-1', 'request-1')
        await waitFor(() => expect(haptic.notification).toHaveBeenCalledWith('error'))
    })
})
