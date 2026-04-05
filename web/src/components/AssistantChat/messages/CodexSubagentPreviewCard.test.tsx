import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import type { ToolCallBlock } from '@/chat/types'
import { CodexSubagentPreviewCard } from '@/components/AssistantChat/messages/CodexSubagentPreviewCard'
import { getToolChildRenderMode } from '@/components/AssistantChat/messages/ToolMessage'
import { HappyToolMessage } from '@/components/AssistantChat/messages/ToolMessage'
import { HappyChatProvider } from '@/components/AssistantChat/context'
import { I18nProvider } from '@/lib/i18n-context'

vi.mock('@/components/MarkdownRenderer', () => ({
    MarkdownRenderer: ({ content }: { content: string }) => {
        const linkMatch = content.match(/\[([^\]]+)\]\(([^)]+)\)/)
        if (linkMatch) {
            return <a href={linkMatch[2]}>{linkMatch[1]}</a>
        }
        return <div>{content}</div>
    }
}))

function makeSpawnBlock(): ToolCallBlock {
    const delegatedPrompt = 'Search GitHub trending repositories for React state tooling'

    return {
        kind: 'tool-call',
        id: 'spawn-block-1',
        localId: null,
        createdAt: 1,
        tool: {
            id: 'spawn-1',
            name: 'CodexSpawnAgent',
            state: 'completed',
            input: {
                message: delegatedPrompt,
                model: 'gpt-5.4-mini'
            },
            createdAt: 1,
            startedAt: 1,
            completedAt: 2,
            description: null,
            result: {
                agent_id: 'agent-1',
                nickname: 'Pauli'
            }
        },
        lifecycle: {
            kind: 'codex-agent-lifecycle',
            agentId: 'agent-1',
            nickname: 'Pauli',
            status: 'waiting',
            latestText: 'Waiting for child agent to finish',
            hiddenToolIds: ['wait-1'],
            actions: [
                { type: 'wait', createdAt: 4, summary: 'Waiting for child agent to finish' }
            ]
        },
        children: [
            {
                kind: 'user-text',
                id: 'child-user-1',
                localId: null,
                createdAt: 3,
                text: delegatedPrompt,
                meta: undefined
            },
            {
                kind: 'agent-text',
                id: 'child-agent-1',
                localId: null,
                createdAt: 4,
                text: 'See [repo](https://github.com/example/repo)',
                meta: undefined
            }
        ]
    }
}

function makeTaskBlock(): ToolCallBlock {
    const delegatedPrompt = 'Investigate flaky Task sidechain rendering'

    return {
        kind: 'tool-call',
        id: 'task-block-1',
        localId: null,
        createdAt: 1,
        tool: {
            id: 'task-1',
            name: 'Task',
            state: 'completed',
            input: {
                prompt: delegatedPrompt
            },
            createdAt: 1,
            startedAt: 1,
            completedAt: 2,
            description: null
        },
        meta: {
            subagent: {
                kind: 'spawn',
                sidechainKey: 'task-1',
                prompt: delegatedPrompt
            }
        },
        children: [
            {
                kind: 'user-text',
                id: 'task-child-user-1',
                localId: null,
                createdAt: 2,
                text: delegatedPrompt,
                meta: undefined
            },
            {
                kind: 'agent-text',
                id: 'task-child-agent-1',
                localId: null,
                createdAt: 3,
                text: 'Task child answer',
                meta: undefined
            }
        ]
    }
}

function makeTaskHybridBlock(): ToolCallBlock {
    const delegatedPrompt = 'Investigate flaky Task sidechain rendering'

    return {
        kind: 'tool-call',
        id: 'task-block-2',
        localId: null,
        createdAt: 1,
        tool: {
            id: 'task-2',
            name: 'Task',
            state: 'completed',
            input: {
                prompt: delegatedPrompt
            },
            createdAt: 1,
            startedAt: 1,
            completedAt: 2,
            description: null
        },
        meta: {
            subagent: {
                kind: 'spawn',
                sidechainKey: 'task-2',
                prompt: delegatedPrompt
            }
        },
        children: [
            {
                kind: 'tool-call',
                id: 'task-pending-child',
                localId: null,
                createdAt: 2,
                tool: {
                    id: 'pending-1',
                    name: 'Bash',
                    state: 'pending',
                    input: {
                        command: ['echo', 'pending child']
                    },
                    createdAt: 2,
                    startedAt: null,
                    completedAt: null,
                    description: null,
                    permission: {
                        id: 'pending-approval-1',
                        status: 'pending'
                    }
                },
                children: []
            },
            {
                kind: 'agent-text',
                id: 'task-child-agent-1',
                localId: null,
                createdAt: 3,
                text: 'Task child answer',
                meta: undefined
            }
        ]
    }
}

function renderWithProviders(ui: ReactElement) {
    if (typeof window !== 'undefined' && !window.matchMedia) {
        window.matchMedia = () => ({
            matches: false,
            media: '',
            onchange: null,
            addListener: () => {},
            removeListener: () => {},
            addEventListener: () => {},
            removeEventListener: () => {},
            dispatchEvent: () => false
        })
    }

    return render(
        <I18nProvider>
            <HappyChatProvider
                value={{
                    api: {} as never,
                    sessionId: 'session-1',
                    metadata: null,
                    disabled: false,
                    onRefresh: () => {}
                }}
            >
                {ui}
            </HappyChatProvider>
        </I18nProvider>
    )
}

afterEach(() => {
    cleanup()
})

describe('CodexSubagentPreviewCard', () => {
    it('keeps child transcript hidden until opened, then shows it in dialog', () => {
        const block = makeSpawnBlock()

        renderWithProviders(
            <CodexSubagentPreviewCard
                block={block}
            />
        )

        expect(screen.getByText('Subagent conversation')).toBeInTheDocument()
        expect(screen.getByText('Waiting')).toBeInTheDocument()
        expect(screen.getByText(/Pauli/)).toBeInTheDocument()
        expect(screen.queryByText(/agent-1/i)).not.toBeInTheDocument()
        expect(screen.getByText(/Waiting for child agent to finish/)).toBeInTheDocument()
        expect(screen.queryByText('See [repo](https://github.com/example/repo)')).not.toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: /Subagent conversation — Pauli/i }))

        expect(screen.getByRole('link', { name: 'repo' })).toHaveAttribute('href', 'https://github.com/example/repo')
        expect(screen.getByRole('button', { name: 'Close dialog' })).toBeInTheDocument()
        expect(screen.getAllByText('Search GitHub trending repositories for React state tooling').length).toBeGreaterThan(0)
    })

    it('renders HappyToolMessage as the lifecycle card for CodexSpawnAgent', () => {
        const block = makeSpawnBlock()
        const props: any = {
            artifact: block,
            toolName: 'CodexSpawnAgent',
            argsText: '{}',
            result: block.tool.result,
            isError: false,
            status: { type: 'complete' }
        }

        renderWithProviders(
            <HappyToolMessage {...props} />
        )

        expect(screen.getByText('Subagent conversation')).toBeInTheDocument()
        expect(screen.getByText('Waiting')).toBeInTheDocument()
        expect(screen.queryByRole('link', { name: 'repo' })).not.toBeInTheDocument()
        expect(screen.queryByText('Search GitHub trending repositories for React state tooling')).not.toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: /Subagent conversation — Pauli/i }))

        expect(screen.getAllByText('Search GitHub trending repositories for React state tooling').length).toBeGreaterThan(0)
        expect(screen.getByRole('link', { name: 'repo' })).toBeInTheDocument()
    })

    it('renders HappyToolMessage as the lifecycle card for Claude Task sidechains while keeping pending children inline', () => {
        const block = makeTaskHybridBlock()
        const props: any = {
            artifact: block,
            toolName: 'Task',
            argsText: '{}',
            result: undefined,
            isError: false,
            status: { type: 'complete' }
        }

        renderWithProviders(
            <HappyToolMessage {...props} />
        )

        expect(screen.getByText('Subagent conversation')).toBeInTheDocument()
        expect(screen.getByText('Completed')).toBeInTheDocument()
        expect(screen.getAllByText('Investigate flaky Task sidechain rendering')).toHaveLength(1)
        expect(screen.getByText('Waiting for approval…')).toBeInTheDocument()
        expect(screen.queryByText('Task child answer')).not.toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: /Subagent conversation/i }))

        expect(screen.getByText('Task child answer')).toBeInTheDocument()
        expect(screen.getAllByText('Waiting for approval…')).toHaveLength(1)
        expect(screen.getAllByText('Investigate flaky Task sidechain rendering').length).toBeGreaterThan(0)
    })

    it('closes the dialog via the top close icon button', () => {
        const block = makeSpawnBlock()

        renderWithProviders(<CodexSubagentPreviewCard block={block} />)

        fireEvent.click(screen.getByRole('button', { name: /Subagent conversation — Pauli/i }))
        expect(screen.getByRole('link', { name: 'repo' })).toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }))

        expect(screen.queryByRole('link', { name: 'repo' })).not.toBeInTheDocument()
    })

    it('marks CodexSpawnAgent children for preview rendering instead of inline expansion', () => {
        const block = makeSpawnBlock()
        expect(getToolChildRenderMode(block)).toBe('codex-subagent-preview')
    })

    it('marks Task children for preview rendering instead of inline expansion', () => {
        const block = makeTaskBlock()
        expect(getToolChildRenderMode(block)).toBe('codex-subagent-preview')
    })

    it('keeps ordinary tool children inline instead of using the subagent preview card', () => {
        const block: ToolCallBlock = {
            kind: 'tool-call',
            id: 'bash-block-1',
            localId: null,
            createdAt: 1,
            tool: {
                id: 'bash-1',
                name: 'Bash',
                state: 'completed',
                input: {
                    command: ['echo', 'ordinary child']
                },
                createdAt: 1,
                startedAt: 1,
                completedAt: 2,
                description: null
            },
            children: [
                {
                    kind: 'agent-text',
                    id: 'bash-child-1',
                    localId: null,
                    createdAt: 2,
                    text: 'ordinary child transcript',
                    meta: undefined
                }
            ]
        }

        expect(getToolChildRenderMode(block)).toBe('inline')

        const props: any = {
            artifact: block,
            toolName: 'Bash',
            argsText: '{}',
            result: undefined,
            isError: false,
            status: { type: 'complete' }
        }

        renderWithProviders(
            <HappyToolMessage {...props} />
        )

        expect(screen.queryByText('Subagent conversation')).not.toBeInTheDocument()
        expect(screen.getByText('ordinary child transcript')).toBeInTheDocument()
    })
})
