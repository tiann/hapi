import { useCallback, useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolCallBlock } from '@/chat/types'
import type { ToolGroupBlock } from '@/chat/toolGroups'
import { HappyChatProvider } from '@/components/AssistantChat/context'
import { ToolGroupCard } from '@/components/ToolCard/ToolGroupCard'
import { I18nProvider } from '@/lib/i18n-context'

function makeToolBlock(id: string, name: string, input: unknown = {}): ToolCallBlock {
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt: 1,
        invokedAt: null,
        tool: {
            id,
            name,
            state: 'completed',
            input,
            createdAt: 1,
            startedAt: 1,
            completedAt: 2,
            description: null,
            result: { content: 'done' },
            permission: undefined,
        },
        children: [],
    }
}

function makeGroup(overrides: Partial<ToolGroupBlock> = {}): ToolGroupBlock {
    const tools = overrides.tools ?? [
        makeToolBlock('read-1', 'Read', { file_path: 'repo/src/a.ts' }),
        makeToolBlock('bash-1', 'Bash', { command: 'bun test' })
    ]
    return {
        kind: 'tool-group',
        id: 'tool-group:read-1',
        createdAt: 1,
        invokedAt: null,
        firstToolId: tools[0].id,
        lastToolId: tools[tools.length - 1].id,
        tools,
        defaultOpen: false,
        historyState: 'complete',
        needsOlderHistory: false,
        summary: {
            totalTools: tools.length,
            countsByKind: {
                read: 1,
                search: 0,
                command: 1,
                mutation: 0,
                web: 0,
                other: 0,
            },
            fileTargets: ['repo/src/a.ts'],
            commandTargets: ['bun test'],
            searchTargets: [],
            urlTargets: [],
            otherTargets: [],
            errorCount: 0,
            runningCount: 0,
            pendingCount: 0,
        },
        ...overrides,
    }
}

function renderCard(block: ToolGroupBlock, options?: { loadOlder?: () => Promise<boolean>; hasMore?: boolean; isLoadingMore?: boolean }) {
    const loadOlderMessagesPreservingScroll = options?.loadOlder ?? vi.fn(async () => false)
    return render(
        <I18nProvider>
            <HappyChatProvider value={{
                api: {} as never,
                sessionId: 'session-1',
                metadata: { path: 'repo', host: 'local' },
                terminalToolDisplayMode: 'detailed',
                disabled: false,
                onRefresh: vi.fn(),
                hasMoreMessages: options?.hasMore ?? false,
                isLoadingMoreMessages: options?.isLoadingMore ?? false,
                loadOlderMessagesPreservingScroll,
            }}>
                <ToolGroupCard block={block} metadata={{ path: 'repo', host: 'local' }} />
            </HappyChatProvider>
        </I18nProvider>
    )
}

describe('ToolGroupCard', () => {
    afterEach(() => {
        cleanup()
    })

    it('renders a collapsed target-first header', () => {
        renderCard(makeGroup())

        expect(screen.getByRole('button', { name: /src\/a.ts/i })).toBeInTheDocument()
        expect(screen.getByText('Read 1 · Run 1')).toBeInTheDocument()
        expect(screen.queryByText('2 tool calls')).not.toBeInTheDocument()
    })

    it('expands to show compact rows and opens a detail dialog per row', async () => {
        const view = renderCard(makeGroup())
        const groupToggle = within(view.container).getByRole('button', { name: /src\/a.ts/i })

        fireEvent.click(groupToggle)
        expect(screen.getByText('2 tool calls')).toBeInTheDocument()

        const firstRowButton = within(view.container)
            .getAllByRole('button')
            .find((button) => button !== groupToggle)

        expect(firstRowButton).toBeDefined()
        fireEvent.click(firstRowButton!)

        await waitFor(() => {
            expect(screen.getByRole('dialog')).toBeInTheDocument()
        })
        const dialog = screen.getByRole('dialog')
        expect(screen.getAllByText('src/a.ts')[0]).toBeInTheDocument()
        expect(within(dialog).getAllByText('Input').length).toBeGreaterThan(0)
        expect(within(dialog).getAllByText('Result').length).toBeGreaterThan(0)
    })

    it('auto-loads older history after expand when the group is incomplete', async () => {
        const loadOlder = vi.fn()

        function Harness() {
            const [hasMore, setHasMore] = useState(true)
            const loadOlderMessagesPreservingScroll = useCallback(async () => {
                loadOlder()
                setHasMore(false)
                return false
            }, [])

            return (
                <I18nProvider>
                    <HappyChatProvider value={{
                        api: {} as never,
                        sessionId: 'session-1',
                        metadata: { path: 'repo', host: 'local' },
                        terminalToolDisplayMode: 'detailed',
                        disabled: false,
                        onRefresh: vi.fn(),
                        hasMoreMessages: hasMore,
                        isLoadingMoreMessages: false,
                        loadOlderMessagesPreservingScroll,
                    }}>
                        <ToolGroupCard
                            block={makeGroup({
                                id: 'tool-group:bash-1',
                                historyState: 'needs-older-history',
                                needsOlderHistory: true,
                            })}
                            metadata={{ path: 'repo', host: 'local' }}
                        />
                    </HappyChatProvider>
                </I18nProvider>
            )
        }

        const view = render(<Harness />)
        const groupToggle = within(view.container).getByRole('button', { name: /src\/a.ts/i })

        fireEvent.click(groupToggle)

        await waitFor(() => {
            expect(loadOlder).toHaveBeenCalledTimes(1)
        })
        await waitFor(() => {
            expect(screen.getByText('Earlier tool activity is unavailable.')).toBeInTheDocument()
        })
    })

    it('continues hydrating incomplete history across multiple page loads', async () => {
        let loadCount = 0

        function Harness() {
            const [isLoadingMore, setIsLoadingMore] = useState(false)
            const [hasMore, setHasMore] = useState(true)
            const loadOlderMessagesPreservingScroll = useCallback(() => {
                const shouldContinue = loadCount === 0
                loadCount += 1
                setIsLoadingMore(true)
                return new Promise<boolean>((resolve) => {
                    setTimeout(() => {
                        setIsLoadingMore(false)
                        if (!shouldContinue) {
                            setHasMore(false)
                        }
                        resolve(shouldContinue)
                    }, 0)
                })
            }, [])

            return (
                <I18nProvider>
                    <HappyChatProvider value={{
                        api: {} as never,
                        sessionId: 'session-1',
                        metadata: { path: 'repo', host: 'local' },
                        terminalToolDisplayMode: 'detailed',
                        disabled: false,
                        onRefresh: vi.fn(),
                        hasMoreMessages: hasMore,
                        isLoadingMoreMessages: isLoadingMore,
                        loadOlderMessagesPreservingScroll,
                    }}>
                        <ToolGroupCard
                            block={makeGroup({
                                id: 'tool-group:bash-1',
                                historyState: 'needs-older-history',
                                needsOlderHistory: true,
                            })}
                            metadata={{ path: 'repo', host: 'local' }}
                        />
                    </HappyChatProvider>
                </I18nProvider>
            )
        }

        const view = render(<Harness />)
        const groupToggle = within(view.container).getByRole('button', { name: /src\/a.ts/i })

        fireEvent.click(groupToggle)

        await waitFor(() => {
            expect(loadCount).toBe(2)
        })
        await waitFor(() => {
            expect(screen.getByText('Earlier tool activity is unavailable.')).toBeInTheDocument()
        })
    })

    it('waits for an in-flight thread pagination to finish before retrying hydration', async () => {
        const loadOlder = vi.fn(async () => false)
        let releaseThreadLoad: (() => void) | null = null

        function Harness() {
            const [hasMore, setHasMore] = useState(true)
            const [isLoadingMore, setIsLoadingMore] = useState(true)

            releaseThreadLoad = () => setIsLoadingMore(false)

            const loadOlderMessagesPreservingScroll = useCallback(async () => {
                loadOlder()
                setHasMore(false)
                return false
            }, [])

            return (
                <I18nProvider>
                    <HappyChatProvider value={{
                        api: {} as never,
                        sessionId: 'session-1',
                        metadata: { path: 'repo', host: 'local' },
                        terminalToolDisplayMode: 'detailed',
                        disabled: false,
                        onRefresh: vi.fn(),
                        hasMoreMessages: hasMore,
                        isLoadingMoreMessages: isLoadingMore,
                        loadOlderMessagesPreservingScroll,
                    }}>
                        <ToolGroupCard
                            block={makeGroup({
                                id: 'tool-group:bash-1',
                                historyState: 'needs-older-history',
                                needsOlderHistory: true,
                            })}
                            metadata={{ path: 'repo', host: 'local' }}
                        />
                    </HappyChatProvider>
                </I18nProvider>
            )
        }

        const view = render(<Harness />)
        const groupToggle = within(view.container).getByRole('button', { name: /src\/a.ts/i })

        fireEvent.click(groupToggle)

        expect(loadOlder).not.toHaveBeenCalled()
        expect(screen.queryByText('Earlier tool activity is unavailable.')).not.toBeInTheDocument()

        await act(async () => {
            releaseThreadLoad?.()
        })

        await waitFor(() => {
            expect(loadOlder).toHaveBeenCalledTimes(1)
        })
        await waitFor(() => {
            expect(screen.getByText('Earlier tool activity is unavailable.')).toBeInTheDocument()
        })
    })
})
