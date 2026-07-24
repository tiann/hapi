import { useCallback, useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolCallBlock } from '@/chat/types'
import type { ToolGroupBlock } from '@/chat/toolGroups'
import { HappyChatProvider } from '@/components/AssistantChat/context'
import { getToolGroupTiming, ToolGroupCard } from '@/components/ToolCard/ToolGroupCard'
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
            execStartedAt: null,
            execCompletedAt: null,
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
        const view = renderCard(makeGroup())

        expect(screen.getByRole('button', { name: /inspect a\.ts/i })).toHaveAttribute('aria-expanded', 'false')
        expect(screen.getByText('Run 1 · Read 1')).toBeInTheDocument()
        expect(screen.queryByText('2 actions')).not.toBeInTheDocument()
        expect(screen.getByText('Run 1 · Read 1')).toHaveClass('text-xs', 'font-normal', 'text-[var(--app-hint)]')
        expect(screen.queryByText('src/a.ts')).not.toBeInTheDocument()
        expect(screen.queryByText('bun test')).not.toBeInTheDocument()

        expect(view.container.innerHTML).toContain('bg-[var(--app-tool-group-bg)]')
    })

    it('derives completed group wall-clock timing from the earliest start and latest finish', () => {
        const first = makeToolBlock('read-1', 'Read')
        first.tool.startedAt = 1_000
        first.tool.completedAt = 2_000
        const second = makeToolBlock('bash-1', 'Bash')
        second.tool.startedAt = 1_500
        second.tool.completedAt = 4_000

        expect(getToolGroupTiming([first, second], 10_000)).toEqual({
            startedAt: 1_000,
            completedAt: 4_000,
            durationMs: 3_000,
            running: false,
        })
    })

    it('shows group start, live duration, and a spinner while collapsed and running', () => {
        const startedAt = Date.now() - 5_000
        const completed = makeToolBlock('read-1', 'Read')
        completed.tool.startedAt = startedAt
        completed.tool.completedAt = startedAt + 1_000
        const running = makeToolBlock('bash-1', 'Bash')
        running.tool.state = 'running'
        running.tool.startedAt = startedAt + 1_000
        running.tool.completedAt = null

        const group = makeGroup({
            tools: [completed, running],
            summary: {
                ...makeGroup().summary,
                runningCount: 1,
            },
        })
        const view = renderCard(group)

        expect(screen.getByText('Started')).toBeInTheDocument()
        expect(screen.getByText('Duration')).toBeInTheDocument()
        expect(screen.queryByText('Finished')).not.toBeInTheDocument()
        expect(within(view.container).getByLabelText('Running')).toBeInTheDocument()
    })

    it('shows final timing in the collapsed header after every tool finishes', () => {
        const startedAt = Date.now() - 4_000
        const first = makeToolBlock('read-1', 'Read')
        first.tool.startedAt = startedAt
        first.tool.completedAt = startedAt + 1_000
        const second = makeToolBlock('bash-1', 'Bash')
        second.tool.startedAt = startedAt + 1_000
        second.tool.completedAt = startedAt + 4_000

        renderCard(makeGroup({ tools: [first, second] }))

        expect(screen.getByText('Started')).toBeInTheDocument()
        expect(screen.getByText('Finished')).toBeInTheDocument()
        expect(screen.getByText('Duration')).toBeInTheDocument()
        expect(screen.getByText('4.0s')).toBeInTheDocument()
    })

    it('expands to show compact rows and opens a detail dialog per row', async () => {
        const view = renderCard(makeGroup())
        const groupToggle = within(view.container).getByRole('button', { name: /inspect a\.ts/i })

        expect(view.container.querySelector('svg[data-state="closed"]')).toBeInTheDocument()
        fireEvent.click(groupToggle)
        expect(groupToggle).toHaveAttribute('aria-expanded', 'true')
        expect(view.container.querySelector('svg[data-state="open"]')).toBeInTheDocument()
        expect(screen.getByText('Run 1 · Read 1')).toBeInTheDocument()
        expect(screen.queryByText('2 actions')).not.toBeInTheDocument()
        expect(screen.getByText('src/a.ts')).toBeInTheDocument()
        expect(screen.getByText('Terminal')).toBeInTheDocument()
        expect(screen.getByText('bun test')).toBeInTheDocument()

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

    it('shows structured Codex exploration actions by default without a generic action count', () => {
        const tools = [
            makeToolBlock('codex-read', 'CodexBash', {
                command: 'cat package.json',
                command_actions: [{
                    type: 'read',
                    command: 'cat package.json',
                    name: 'package.json',
                    path: '/repo/package.json'
                }]
            }),
            makeToolBlock('codex-search', 'CodexBash', {
                command: 'rg nativeTitle web/src',
                command_actions: [{
                    type: 'search',
                    command: 'rg nativeTitle web/src',
                    query: 'nativeTitle',
                    path: 'web/src'
                }]
            })
        ]
        const view = renderCard(makeGroup({
            tools,
            defaultOpen: true,
            presentationMode: 'codex-exploration',
            summary: {
                totalTools: 2,
                countsByKind: { read: 0, search: 0, command: 2, mutation: 0, web: 0, other: 0 },
                fileTargets: [],
                commandTargets: ['cat package.json', 'rg nativeTitle web/src'],
                searchTargets: [],
                urlTargets: [],
                otherTargets: [],
                errorCount: 0,
                runningCount: 0,
                pendingCount: 0,
            }
        }))

        expect(within(view.container).getByRole('button', { name: /^explored\b/i })).toHaveAttribute('aria-expanded', 'true')
        expect(screen.getByText('Read')).toBeInTheDocument()
        expect(screen.getByText('package.json')).toBeInTheDocument()
        expect(screen.getByText('Search')).toBeInTheDocument()
        expect(screen.getByText('nativeTitle in web/src')).toBeInTheDocument()
        expect(screen.queryByText('2 actions')).not.toBeInTheDocument()
    })

    it('uses a neutral header for all-generic tool groups without duplicate counters', () => {
        const tools = Array.from({ length: 25 }, (_, index) => makeToolBlock(`tool-${index + 1}`, 'Tool', { name: `Tool ${index + 1}` }))
        const view = renderCard(makeGroup({
            tools,
            summary: {
                totalTools: tools.length,
                countsByKind: {
                    read: 0,
                    search: 0,
                    command: 0,
                    mutation: 0,
                    web: 0,
                    other: tools.length,
                },
                fileTargets: [],
                commandTargets: [],
                searchTargets: [],
                urlTargets: [],
                otherTargets: tools.map((tool) => tool.tool.name),
                errorCount: 0,
                runningCount: 0,
                pendingCount: 0,
            },
        }))

        expect(screen.getByRole('button', { name: /tool activity/i })).toBeInTheDocument()
        expect(screen.getByText('25 actions')).toBeInTheDocument()
        expect(screen.queryByText('Use tool +24')).not.toBeInTheDocument()
        expect(screen.queryByText('Tool 25')).not.toBeInTheDocument()

        fireEvent.click(within(view.container).getByRole('button', { name: /tool activity/i }))

        expect(screen.getAllByText('Tool').length).toBeGreaterThan(0)
        expect(screen.getByText('Tool 1')).toBeInTheDocument()
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
        const groupToggle = within(view.container).getByRole('button', { name: /inspect a\.ts/i })

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
        const groupToggle = within(view.container).getByRole('button', { name: /inspect a\.ts/i })

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
        const groupToggle = within(view.container).getByRole('button', { name: /inspect a\.ts/i })

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
