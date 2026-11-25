import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { ToolCallBlock } from '@/chat/types'
import { ToolCard } from '@/components/ToolCard/ToolCard'
import { getToolResultViewComponent } from '@/components/ToolCard/views/_results'
import { I18nProvider } from '@/lib/i18n-context'

const goal = {
    objective: 'Compare the options and validate the chosen approach.', status: 'active', threadId: 'thread-1',
    tokensUsed: 0, tokenBudget: null, timeUsedSeconds: 0,
    createdAt: 1704067200, updatedAt: 1704067200
}

function goalBlock(result: unknown, state: ToolCallBlock['tool']['state'] = 'completed', name = 'create_goal', input: unknown = { objective: 'requested objective', status: 'complete' }): ToolCallBlock {
    return {
        kind: 'tool-call', id: 'goal-1', localId: null, createdAt: 1000, children: [],
        tool: {
            id: 'goal-1', name, state, input,
            result, description: null, createdAt: 1000, startedAt: 1000, completedAt: 1500,
            execStartedAt: null, execCompletedAt: null
        }
    }
}

function renderGoal(result: unknown, state: ToolCallBlock['tool']['state'] = 'completed', name = 'create_goal', input?: unknown) {
    return render(<I18nProvider><ToolCard
        api={{} as ApiClient} sessionId="session-1" metadata={null}
        terminalToolDisplayMode="detailed" disabled={false} onDone={() => {}} block={goalBlock(result, state, name, input)}
    /></I18nProvider>)
}

describe('goal cards in ToolCard', () => {
    beforeEach(() => localStorage.setItem('hapi-lang', 'en'))

    it.each(['create_goal', 'get_goal', 'update_goal', 'functions.create_goal', 'functions.get_goal', 'functions.update_goal'])('shows the snapshot once for %s', (name) => {
        renderGoal(JSON.stringify({ goal }), 'completed', name)
        expect(screen.getAllByText(goal.objective)).toHaveLength(1)
        expect(screen.getByText('Active')).toBeInTheDocument()
        expect(screen.getByText('0 tokens')).toBeInTheDocument()
        expect(screen.getByText('No limit')).toBeInTheDocument()
        expect(screen.getByText('0.0s')).toBeInTheDocument()
        expect(screen.queryByText('requested objective')).not.toBeInTheDocument()
        expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
        expect(screen.queryByText('thread-1')).not.toBeInTheDocument()
    })

    it('shows token budget consumption without hiding over-budget usage', () => {
        renderGoal({ goal: { ...goal, tokensUsed: 150, tokenBudget: 100 } })
        expect(screen.getByText('150 / 100 tokens')).toBeInTheDocument()
        expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100')
        expect(screen.getByRole('progressbar')).toHaveAccessibleName('Token budget used')
    })

    it('shows no goal distinctly', () => {
        renderGoal({ goal: null })
        expect(screen.getByText('No goal set')).toBeInTheDocument()
        expect(screen.queryByText('Active')).not.toBeInTheDocument()
    })

    it('does not infer successful goal state while pending', () => {
        renderGoal(undefined, 'pending')
        expect(screen.getByText('requested objective')).toBeInTheDocument()
        expect(screen.queryByText('Complete')).not.toBeInTheDocument()
    })

    it.each([
        ['en', 'Requested status', 'Complete'],
        ['zh-CN', '请求的状态', '已完成']
    ])('labels status-only pending requests in %s without a successful state badge', (locale, label, status) => {
        localStorage.setItem('hapi-lang', locale)
        const { container } = renderGoal(undefined, 'pending', 'update_goal', { status: 'complete' })
        expect(screen.getByText(label)).toBeInTheDocument()
        expect(screen.getByText(status)).toBeInTheDocument()
        expect(screen.queryByText('complete')).not.toBeInTheDocument()
        expect(container.querySelector('[data-goal-status]')).toBeNull()
    })

    it('keeps unknown requested statuses readable', () => {
        renderGoal(undefined, 'pending', 'update_goal', { status: 'futureState' })
        expect(screen.getByText('Requested status')).toBeInTheDocument()
        expect(screen.getByText('futureState')).toBeInTheDocument()
    })

    it.each([
        ['en', 0, '0.0s'], ['zh-CN', 0, '0.0s'],
        ['en', 0.5, '0.5s'], ['zh-CN', 0.5, '0.5s'],
        ['en', 76, '1m 16s'], ['zh-CN', 76, '1m 16s']
    ])('uses the common duration format for %s at %s seconds', (locale, seconds, duration) => {
        localStorage.setItem('hapi-lang', locale)
        const { container } = renderGoal({ goal: { ...goal, timeUsedSeconds: seconds } })
        expect(within(container.querySelector('[data-goal-status]') as HTMLElement).getByText(duration)).toBeInTheDocument()
    })

    it.each(['error', 'completed'] as const)('preserves the generic fallback for %s errors', (state) => {
        renderGoal('Permission denied', state)
        expect(screen.getByText('Permission denied')).toBeInTheDocument()
        expect(screen.queryByText('Active')).not.toBeInTheDocument()
    })

    it('does not render a successful-looking goal payload when the tool failed', () => {
        renderGoal({ goal }, 'error')
        expect(screen.queryByText('Active')).not.toBeInTheDocument()
        expect(screen.getByText('Result')).toBeInTheDocument()
    })

    it('keeps unknown status readable and omits absent metrics', () => {
        renderGoal({ goal: { objective: goal.objective, status: 'futureState' } })
        expect(screen.getByText('futureState')).toBeInTheDocument()
        expect(screen.queryByText('0 tokens')).not.toBeInTheDocument()
        expect(screen.queryByText('0.0s')).not.toBeInTheDocument()
    })

    it('shows metadata and collapsed original JSON only in the detail dialog', () => {
        renderGoal({ goal })
        fireEvent.click(screen.getByRole('button', { expanded: false }))
        const dialog = screen.getByRole('dialog')
        expect(within(dialog).getByText('thread-1')).toBeInTheDocument()
        const raw = within(dialog).getByText('Raw JSON').closest('details')!
        expect(raw.open).toBe(false)
        fireEvent.click(within(dialog).getByText('Raw JSON'))
        expect(within(dialog).getByText('Raw JSON').closest('details')).toBe(raw)
    })

    it('keeps metadata and raw output when used by a trace result without a surface', () => {
        const ResultView = getToolResultViewComponent('get_goal')
        render(<I18nProvider><ResultView block={goalBlock({ goal })} metadata={null} /></I18nProvider>)
        expect(screen.getByText('thread-1')).toBeInTheDocument()
        expect(screen.getByText('Raw JSON').closest('details')?.open).toBe(false)
    })

    it('hides times that overflow millisecond conversion', () => {
        const { container } = renderGoal({ goal: { ...goal, timeUsedSeconds: Number.MAX_VALUE } })
        expect(container.textContent).not.toMatch(/Infinity|NaN/)
        expect(screen.getByText(goal.objective)).toBeInTheDocument()
    })
})
