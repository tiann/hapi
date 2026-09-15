import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { ToolCallBlock } from '@/chat/types'
import { HappyChatProvider, type HappyChatContextValue } from '@/components/AssistantChat/context'
import { ToolCard } from './ToolCard'

vi.mock('@/hooks/usePlatform', () => ({ usePlatform: () => ({ haptic: { notification: vi.fn() } }) }))
vi.mock('@/lib/use-translation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/components/MarkdownRenderer', () => ({ MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div> }))

function fixture(overrides: Partial<HappyChatContextValue> = {}) {
    const implement = vi.fn(async (_sessionId: string, _planId: string) => {})
    const continued = vi.fn()
    const refresh = vi.fn()
    const ctx: HappyChatContextValue = {
        api: { implementCodexPlan: implement } as unknown as ApiClient, sessionId: 'session',
        metadata: { path: '/tmp', host: 'test', flavor: 'codex' },
        terminalToolDisplayMode: 'compact', showSessionSummaryInChat: false, disabled: false,
        onRefresh: refresh, onContinuePlan: continued, codexPlanProposalId: 'plan',
        hasMoreMessages: false, isSyncingTail: false, isLoadingMoreMessages: false,
        loadOlderMessagesPreservingScroll: async () => 'loaded', ...overrides
    }
    const block: ToolCallBlock = {
        kind: 'tool-call', id: 'plan', localId: null, createdAt: 1, children: [],
        tool: { id: 'plan', name: 'ExitPlanMode', input: { plan: '# Durable proposal' }, state: 'completed',
            createdAt: 1, startedAt: 1, completedAt: 2, execStartedAt: null, execCompletedAt: null, description: null, result: null }
    }
    let cardMount = 0
    const ui = () => <HappyChatProvider value={{ ...ctx }}>
        <ToolCard key={`${block.id}:${cardMount}`} block={{ ...block, tool: { ...block.tool } }} api={ctx.api} sessionId={ctx.sessionId} metadata={ctx.metadata}
            disabled={ctx.disabled} onDone={ctx.onRefresh} terminalToolDisplayMode="compact" />
    </HappyChatProvider>
    const view = render(ui())
    return {
        ctx, block, implement, continued, refresh,
        remount: () => { cardMount++; view.rerender(ui()) },
        rerender: () => view.rerender(ui())
    }
}

describe('shared Codex plan card', () => {
    it('dismisses actions and focuses the composer without creating an approval request', () => {
        const f = fixture()
        expect(screen.getByText('# Durable proposal')).toBeInTheDocument()
        expect(screen.queryByText('tool.waitingForApproval')).not.toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'tool.plan.continue' }))
        expect(f.continued).toHaveBeenCalledOnce()
        expect(f.implement).not.toHaveBeenCalled()
        expect(screen.queryByRole('button', { name: 'tool.plan.continue' })).not.toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'tool.plan.implement' })).not.toBeInTheDocument()
        expect(screen.getByText('# Durable proposal')).toBeInTheDocument()
        // Recycling the card and a stale live proposal must not revive the menu.
        f.remount()
        f.ctx.codexPlanProposalId = null
        f.rerender()
        f.ctx.codexPlanProposalId = 'plan'
        f.rerender()
        expect(screen.queryByRole('button', { name: 'tool.plan.continue' })).not.toBeInTheDocument()
    })

    it('offers actions for a new proposal after continuing the previous one', () => {
        const f = fixture()
        fireEvent.click(screen.getByRole('button', { name: 'tool.plan.continue' }))
        f.ctx.codexPlanProposalId = 'new-plan'
        f.block.id = 'new-plan'
        f.block.tool.id = 'new-plan'
        f.rerender()
        expect(screen.getByRole('button', { name: 'tool.plan.continue' })).toBeEnabled()
        expect(screen.getByRole('button', { name: 'tool.plan.implement' })).toBeEnabled()
    })

    it('submits once and keeps pending feedback while the native action removes the available id', async () => {
        const f = fixture()
        let finish!: () => void
        f.implement.mockImplementation(() => new Promise(resolve => { finish = resolve }))
        const button = screen.getByRole('button', { name: 'tool.plan.implement' })
        fireEvent.click(button); fireEvent.click(button)
        expect(f.implement).toHaveBeenCalledExactlyOnceWith('session', 'plan')
        expect(button).toBeDisabled()
        f.ctx.codexPlanProposalId = null; f.rerender()
        expect(screen.getByRole('button', { name: 'tool.plan.implement' })).toHaveAttribute('aria-busy', 'true')
        await act(async () => finish())
        expect(screen.queryByRole('button', { name: 'tool.plan.implement' })).not.toBeInTheDocument()
        expect(screen.getByText('# Durable proposal')).toBeInTheDocument()
        expect(f.refresh).toHaveBeenCalledOnce()
    })

    it('retains proposal content and a visible failure after a rejected action', async () => {
        const f = fixture()
        f.implement.mockRejectedValue(new Error('This plan is no longer actionable'))
        fireEvent.click(screen.getByRole('button', { name: 'tool.plan.implement' }))
        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('no longer actionable'))
        f.ctx.codexPlanProposalId = null; f.rerender()
        expect(screen.getByText('# Durable proposal')).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'tool.plan.implement' })).not.toBeInTheDocument()
        expect(f.implement).toHaveBeenCalledOnce()
    })

    it('dismisses an earlier implementation error along with the actions', async () => {
        const f = fixture()
        f.implement.mockRejectedValue(new Error('Try again'))
        fireEvent.click(screen.getByRole('button', { name: 'tool.plan.implement' }))
        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Try again'))
        fireEvent.click(screen.getByRole('button', { name: 'tool.plan.continue' }))
        expect(screen.queryByRole('alert')).not.toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'tool.plan.implement' })).not.toBeInTheDocument()
    })

    it.each([null, 'child-plan', 'newer-plan'])('keeps historical plans read-only when the current id is %s', codexPlanProposalId => {
        fixture({ codexPlanProposalId })
        expect(screen.getByText('# Durable proposal')).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'tool.plan.implement' })).not.toBeInTheDocument()
    })

    it('disables both actions while disconnected', () => {
        const f = fixture({ disabled: true })
        const implement = screen.getByRole('button', { name: 'tool.plan.implement' })
        const continued = screen.getByRole('button', { name: 'tool.plan.continue' })
        expect(implement).toBeDisabled(); expect(continued).toBeDisabled()
        fireEvent.click(implement); fireEvent.click(continued)
        expect(f.implement).not.toHaveBeenCalled(); expect(f.continued).not.toHaveBeenCalled()
    })
})
