import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ToolCallBlock } from '@/chat/types'
import { I18nProvider } from '@/lib/i18n-context'
import { ToolCard } from '@/components/ToolCard/ToolCard'

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

function createExitPlanBlock(overrides?: Partial<ToolCallBlock['tool']>): ToolCallBlock {
    return {
        kind: 'tool-call',
        id: 'tool-1',
        localId: null,
        createdAt: 1,
        tool: {
            id: 'tool-1',
            name: 'exit_plan_mode',
            state: 'pending',
            input: { plan: 'Implement feature X' },
            createdAt: 1,
            startedAt: null,
            completedAt: null,
            description: null,
            permission: {
                id: 'permission-1',
                status: 'pending'
            },
            ...overrides
        },
        children: []
    }
}

function createTaskBlock(child: ToolCallBlock): ToolCallBlock {
    return {
        kind: 'tool-call',
        id: 'task-1',
        localId: null,
        createdAt: 1,
        tool: {
            id: 'task-1',
            name: 'Task',
            state: 'running',
            input: {
                description: 'Main task'
            },
            createdAt: 1,
            startedAt: 1,
            completedAt: null,
            description: null
        },
        children: [child]
    }
}

describe('ToolCard', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('keeps exit-plan dialog focused on input and hides the result pane', () => {
        const localStorageMock = {
            getItem: vi.fn(() => 'en'),
            setItem: vi.fn(),
            removeItem: vi.fn()
        }
        Object.defineProperty(window, 'localStorage', { value: localStorageMock, configurable: true })

        renderWithProviders(
            <ToolCard
                api={{
                    approvePermission: vi.fn(async () => {}),
                    denyPermission: vi.fn(async () => {})
                } as never}
                sessionId="session-1"
                metadata={null}
                disabled={false}
                onDone={vi.fn()}
                block={createExitPlanBlock()}
            />
        )

        fireEvent.click(screen.getByRole('button', { name: 'Execute Plan' }))

        expect(screen.getByText('Input')).toBeInTheDocument()
        expect(screen.queryByText('Result')).not.toBeInTheDocument()
    })

    it('localizes exit-plan child labels inside task summaries', () => {
        const localStorageMock = {
            getItem: vi.fn(() => 'zh-CN'),
            setItem: vi.fn(),
            removeItem: vi.fn()
        }
        Object.defineProperty(window, 'localStorage', { value: localStorageMock, configurable: true })

        renderWithProviders(
            <ToolCard
                api={{
                    approvePermission: vi.fn(async () => {}),
                    denyPermission: vi.fn(async () => {})
                } as never}
                sessionId="session-1"
                metadata={null}
                disabled={false}
                onDone={vi.fn()}
                block={createTaskBlock(createExitPlanBlock({
                    state: 'completed',
                    permission: {
                        id: 'permission-1',
                        status: 'approved',
                        implementationMode: 'keep_context'
                    }
                }))}
            />
        )

        expect(screen.getByText('执行计划')).toBeInTheDocument()
        expect(screen.queryByText('Execute Plan')).not.toBeInTheDocument()
    })
})
