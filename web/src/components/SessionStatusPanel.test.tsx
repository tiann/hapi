import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { SessionStatusPanel } from './SessionStatusPanel'

afterEach(() => cleanup())

describe('SessionStatusPanel', () => {
    it('shows summary badges and invokes onInspectSubagent when a subagent row is clicked', () => {
        const onInspectSubagent = vi.fn()
        render(
            <I18nProvider>
                <SessionStatusPanel
                    data={{
                        goal: null,
                        tasks: [
                            { id: 't1', content: 'Plan', priority: 'medium', status: 'completed' },
                            { id: 't2', content: 'Verify', priority: 'high', status: 'in_progress' }
                        ],
                        subagents: [
                            {
                                id: 'agent-call-1',
                                blockId: 'block-agent-1',
                                title: 'Code reviewer',
                                detail: 'Read src/api.ts',
                                state: 'running',
                                startedAt: Date.now() - 5000,
                                endedAt: null
                            }
                        ],
                        terminals: []
                    }}
                    onInspectSubagent={onInspectSubagent}
                />
            </I18nProvider>
        )

        expect(screen.getByText('Subagents 1')).toBeInTheDocument()
        expect(screen.getByText('Tasks 1/2')).toBeInTheDocument()

        const inspectBtn = screen.getByRole('button', { name: 'Inspect subagent: Code reviewer' })
        fireEvent.click(inspectBtn)
        expect(onInspectSubagent).toHaveBeenCalledWith(expect.objectContaining({
            id: 'agent-call-1',
            blockId: 'block-agent-1'
        }))
    })

    it('renders linked child sessions with distinct session-link icons and clean idle rows', () => {
        const onInspectSubagent = vi.fn()
        render(
            <I18nProvider>
                <SessionStatusPanel
                    data={{
                        goal: null,
                        tasks: [],
                        subagents: [
                            {
                                id: 'block-live',
                                blockId: 'block-1',
                                title: 'Ephemeral Task',
                                detail: 'Grep',
                                state: 'running',
                                startedAt: Date.now() - 2000,
                                endedAt: null,
                            },
                            {
                                id: 'session:child-1',
                                blockId: null,
                                title: 'Codex Fork Worker',
                                detail: 'codex',
                                state: 'idle',
                                startedAt: null,
                                endedAt: null,
                                linkedSessionId: 'child-1',
                                linkKind: 'fork',
                            },
                        ],
                        terminals: [],
                    }}
                    onInspectSubagent={onInspectSubagent}
                />
            </I18nProvider>
        )

        expect(screen.getByText('Subagents 1/2')).toBeInTheDocument()
        expect(screen.getByText('fork')).toBeInTheDocument()
        expect(screen.queryByText('idle')).toBeNull()

        const link = screen.getByRole('link', { name: 'Open session: Codex Fork Worker' })
        expect(link.getAttribute('href')).toBe('/sessions/child-1')
        fireEvent.click(link)
        expect(onInspectSubagent).toHaveBeenCalledWith(expect.objectContaining({
            linkedSessionId: 'child-1',
            linkKind: 'fork',
        }))
    })
})
