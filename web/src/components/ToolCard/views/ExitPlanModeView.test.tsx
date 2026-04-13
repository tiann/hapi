import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ToolCallBlock } from '@/chat/types'
import { I18nProvider } from '@/lib/i18n-context'
import { ExitPlanModeView } from '@/components/ToolCard/views/ExitPlanModeView'

vi.mock('@/components/MarkdownRenderer', () => ({
    MarkdownRenderer: (props: { content: string }) => <div>{props.content}</div>
}))

function renderWithProviders(ui: React.ReactElement) {
    return render(
        <I18nProvider>
            {ui}
        </I18nProvider>
    )
}

function createBlock(overrides?: Partial<ToolCallBlock['tool']>): ToolCallBlock {
    return {
        kind: 'tool-call',
        id: 'tool-1',
        localId: null,
        createdAt: 1,
        tool: {
            id: 'tool-1',
            name: 'exit_plan_mode',
            state: 'completed',
            input: { plan: 'Implement the approved plan' },
            createdAt: 1,
            startedAt: 1,
            completedAt: 2,
            description: null,
            ...overrides
        },
        children: []
    }
}

describe('ExitPlanModeView', () => {
    beforeEach(() => {
        const localStorageMock = {
            getItem: vi.fn(() => 'en'),
            setItem: vi.fn(),
            removeItem: vi.fn()
        }
        Object.defineProperty(window, 'localStorage', { value: localStorageMock, configurable: true })
    })

    it('shows the approved implementation choice', () => {
        renderWithProviders(
            <ExitPlanModeView
                block={createBlock({
                    permission: {
                        id: 'permission-1',
                        status: 'approved',
                        implementationMode: 'clear_context'
                    }
                })}
                metadata={null}
            />
        )

        expect(screen.getByText('Selected implementation')).toBeInTheDocument()
        expect(screen.getByText('Clear context')).toBeInTheDocument()
        expect(screen.getByText('Start implementation in a new Claude session.')).toBeInTheDocument()
    })

    it('shows denied reasons', () => {
        renderWithProviders(
            <ExitPlanModeView
                block={createBlock({
                    permission: {
                        id: 'permission-1',
                        status: 'denied',
                        reason: 'Need a smaller implementation scope first.'
                    }
                })}
                metadata={null}
            />
        )

        expect(screen.getByText('Need a smaller implementation scope first.')).toBeInTheDocument()
    })

    it('shows fallback denied copy when no explicit reason is present', () => {
        renderWithProviders(
            <ExitPlanModeView
                block={createBlock({
                    permission: {
                        id: 'permission-1',
                        status: 'denied'
                    }
                })}
                metadata={null}
            />
        )

        expect(screen.getByText('Plan not approved.')).toBeInTheDocument()
    })
})
