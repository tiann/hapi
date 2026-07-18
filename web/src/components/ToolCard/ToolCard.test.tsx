import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ApiClient } from '@/api/client'
import type { ToolCallBlock } from '@/chat/types'
import { ToolCard } from '@/components/ToolCard/ToolCard'
import { I18nProvider } from '@/lib/i18n-context'

vi.mock('@/hooks/usePlatform', () => ({
    usePlatform: () => ({
        isTelegram: false,
        isTouch: false,
        haptic: {
            impact: vi.fn(),
            notification: vi.fn(),
            selection: vi.fn()
        }
    })
}))

afterEach(() => {
    cleanup()
    vi.clearAllMocks()
})

const api = {
    approvePermission: vi.fn(async () => undefined),
    denyPermission: vi.fn(async () => undefined)
} as unknown as ApiClient

function renderToolCard(block: ToolCallBlock) {
    return render(
        <I18nProvider>
            <ToolCard
                api={api}
                sessionId="session-1"
                metadata={null}
                disabled={false}
                onDone={vi.fn()}
                block={block}
            />
        </I18nProvider>
    )
}

function makeBlock({ name, ...overrides }: Partial<ToolCallBlock['tool']> & { name: string }): ToolCallBlock {
    return {
        kind: 'tool-call',
        id: 'tool-1',
        localId: null,
        createdAt: 0,
        tool: {
            id: 'tool-1',
            name,
            state: 'completed',
            input: {},
            createdAt: 0,
            startedAt: 0,
            completedAt: 0,
            description: null,
            ...overrides
        },
        children: []
    }
}

describe('ToolCard density', () => {
    it('collapses non-actionable tool bodies by default', () => {
        renderToolCard(makeBlock({
            name: 'update_plan',
            input: {
                plan: [
                    { step: 'Hidden tool planning step', status: 'completed' },
                    { step: 'Another hidden planning step', status: 'in_progress' }
                ]
            }
        }))

        expect(screen.getByTestId('tool-card')).toHaveAttribute('data-tool-density', 'compact')
        expect(screen.getByText('Plan')).toBeInTheDocument()
        expect(screen.getByText('2 steps')).toBeInTheDocument()
        expect(screen.queryByText('Hidden tool planning step')).not.toBeInTheDocument()
        expect(screen.queryByText('Another hidden planning step')).not.toBeInTheDocument()
    })

    it('keeps pending permission controls visible', () => {
        renderToolCard(makeBlock({
            name: 'Bash',
            state: 'pending',
            input: { command: 'rm -rf /tmp/example' },
            permission: {
                id: 'permission-1',
                status: 'pending'
            }
        }))

        expect(screen.getByTestId('tool-card')).toHaveAttribute('data-tool-density', 'actionable')
        expect(screen.getByRole('button', { name: 'Allow' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Deny' })).toBeInTheDocument()
    })

    it('exposes complete raw input and result payloads in the tool dialog', () => {
        renderToolCard(makeBlock({
            name: 'Bash',
            input: {
                command: 'echo visible-command',
                cwd: 'RAW_INPUT_SENTINEL',
            },
            result: {
                stdout: 'visible-result',
                exitCode: 0,
                diagnostic: 'RAW_RESULT_SENTINEL',
            },
        }))

        fireEvent.click(screen.getByRole('button', { name: /Terminal/ }))

        expect(screen.getByTestId('tool-raw-input-payload')).toHaveTextContent('RAW_INPUT_SENTINEL')
        expect(screen.getByTestId('tool-raw-result-payload')).toHaveTextContent('RAW_RESULT_SENTINEL')
    })
})
