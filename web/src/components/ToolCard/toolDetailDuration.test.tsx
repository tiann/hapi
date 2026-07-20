import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import type { ChatToolCall, ToolCallBlock } from '@/chat/types'
import { ToolDetailDialogContent } from '@/components/ToolCard/ToolCard'
import { I18nProvider } from '@/lib/i18n-context'

function renderWithI18n(ui: ReactElement) {
    return render(<I18nProvider>{ui}</I18nProvider>)
}

function makeBlock(tool: Partial<ChatToolCall>): ToolCallBlock {
    return {
        kind: 'tool-call',
        id: 'tool-1',
        localId: null,
        createdAt: 0,
        tool: {
            id: 'tool-1',
            name: 'Bash',
            state: 'completed',
            input: { command: 'ls' },
            createdAt: 0,
            startedAt: 0,
            completedAt: 0,
            execStartedAt: null,
            execCompletedAt: null,
            description: null,
            result: 'ok',
            ...tool,
        },
        children: [],
    }
}

describe('ToolDetailDialogContent — duration row', () => {
    it('shows a Duration row for a completed tool', () => {
        renderWithI18n(<ToolDetailDialogContent block={makeBlock({ state: 'completed', startedAt: 1000, completedAt: 3500 })} metadata={null} />)
        expect(screen.getByText('Duration')).toBeTruthy()
        expect(screen.getByText('2.5s')).toBeTruthy()
    })

    it('shows a Duration row for an error tool that completed', () => {
        renderWithI18n(<ToolDetailDialogContent block={makeBlock({ state: 'error', startedAt: 1000, completedAt: 1800 })} metadata={null} />)
        expect(screen.getByText('Duration')).toBeTruthy()
        expect(screen.getByText('0.8s')).toBeTruthy()
    })

    it('does not show a Duration row while running (no completedAt)', () => {
        renderWithI18n(<ToolDetailDialogContent block={makeBlock({ state: 'running', startedAt: 1000, completedAt: null })} metadata={null} />)
        expect(screen.queryByText('Duration')).toBeNull()
    })

    it('does not show a Duration row on clock skew (completedAt precedes startedAt)', () => {
        renderWithI18n(<ToolDetailDialogContent block={makeBlock({ state: 'completed', startedAt: 3500, completedAt: 1000 })} metadata={null} />)
        expect(screen.queryByText('Duration')).toBeNull()
    })

    it('does not show a Duration row while pending (no startedAt, no completedAt)', () => {
        renderWithI18n(<ToolDetailDialogContent block={makeBlock({ state: 'pending', startedAt: null, completedAt: null })} metadata={null} />)
        expect(screen.queryByText('Duration')).toBeNull()
    })

    it('coexists with the Trace section summary on a completed Task tool call', () => {
        // Task/CodexAgent tool calls render their own Trace section summary
        // (children count/tokens/duration, self-reported by the tool result) in
        // the same dialog. This guards against the two duration sources
        // (hub wall-clock vs. tool-self-reported) silently clashing or crashing
        // when both are present.
        const child = makeBlock({ id: 'child-1', name: 'Read', state: 'completed' })
        const block: ToolCallBlock = {
            kind: 'tool-call',
            id: 'task-1',
            localId: null,
            createdAt: 0,
            children: [child],
            tool: {
                id: 'task-1',
                name: 'Task',
                state: 'completed',
                input: { subagent_type: 'Explore' },
                createdAt: 0,
                startedAt: 1000,
                completedAt: 3500,
                execStartedAt: null,
                execCompletedAt: null,
                description: null,
                result: { totalDurationMs: 2400, totalTokens: 1000, totalToolUseCount: 1 },
            },
        }

        renderWithI18n(<ToolDetailDialogContent block={block} metadata={null} />)

        expect(screen.getByText('Duration')).toBeTruthy()
        expect(screen.getByText('2.5s')).toBeTruthy()
        expect(screen.getByText('Trace')).toBeTruthy()
    })

    it('prefers the claude execution-machine timestamps over hub receive time when both are present', () => {
        // Hub receipt shows an inflated 2.5s window (hub queue/transport
        // overhead); the claude entries themselves show the true 2.0s.
        renderWithI18n(<ToolDetailDialogContent block={makeBlock({
            state: 'completed',
            startedAt: 1000,
            completedAt: 3500,
            execStartedAt: 1100,
            execCompletedAt: 3100,
        })} metadata={null} />)
        expect(screen.getByText('Duration')).toBeTruthy()
        expect(screen.getByText('2.0s')).toBeTruthy()
    })

    it('falls back to the hub receive time when exec timestamps are absent (non-Claude agent, no regression)', () => {
        renderWithI18n(<ToolDetailDialogContent block={makeBlock({
            state: 'completed',
            startedAt: 1000,
            completedAt: 3500,
            execStartedAt: null,
            execCompletedAt: null,
        })} metadata={null} />)
        expect(screen.getByText('Duration')).toBeTruthy()
        expect(screen.getByText('2.5s')).toBeTruthy()
    })
})
